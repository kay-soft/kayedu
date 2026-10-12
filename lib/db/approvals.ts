import type {
  ChangeRequest,
  ChangeRequestStatus,
  ChangeRequestType,
  ConflictPolicy,
  Prisma,
  PrismaClient,
  Session,
} from "@prisma/client";
// Relative imports on purpose — `npm run check:approvals` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/reservations.ts and lib/db/payments.ts).
import {
  decideConflicts,
  findSessionConflicts,
  type ScheduleConflict,
} from "../scheduling.ts";
import { effectiveRoomIds } from "../rooms.ts";
import { writeSessionExtraRooms } from "./room-sets.ts";
import { loadSessionOccupancy, writeConfirmedConflictAudit } from "./slot-conflicts.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";

/**
 * The Approvals screen's write path for `ChangeRequest` (M6/M7 gap, closed at
 * this milestone — docs/00-master-product-spec.md §4.1 item 9). A plain
 * status flip, unlike `Reservation`'s `confirmReservation` — accepting a
 * `NEW_CLASS` request does **not** create a `ClassGroup`: the request payload
 * (subject/grade/day/time/capacity/attendance settings, `lib/validation/
 * teacher.ts`'s `classRequestSchema`) is missing fields a real class needs
 * (price, center-cut config, room) that only a center decides, so
 * auto-creating one would have to guess at money — never acceptable
 * (CLAUDE.md rule 2). Accepting here means "yes, go create this class" and
 * staff do that manually at `/classes`, reading the approved request's
 * details off this screen. Never `UPDATE`s in place without a status check —
 * a request already resolved cannot be re-resolved.
 *
 * Takes `centerId`/`db` explicitly rather than `ScopedDb`, exactly like
 * `lib/db/reservations.ts`'s `confirmReservation`/`rejectReservation` and
 * `lib/db/payments.ts`'s `recordPayment`/`voidPayment` — the caller (the
 * Server Action) writes the `AuditLog` row afterward (CLAUDE.md rule 7),
 * this function does not.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const PENDING: ChangeRequestStatus = "PENDING";
const NEW_SESSION: ChangeRequestType = "NEW_SESSION";

export type ResolveChangeRequestResult =
  | { ok: true; changeRequest: ChangeRequest }
  | { ok: false; error: "notFound" | "notPending" };

export async function resolveChangeRequest(
  db: Db,
  centerId: string,
  changeRequestId: string,
  decision: Exclude<ChangeRequestStatus, "PENDING">,
  resolvedBy: string,
): Promise<ResolveChangeRequestResult> {
  const existing = await db.changeRequest.findFirst({
    where: scopedWhere(centerId, { id: changeRequestId }),
  });
  if (!existing) return { ok: false, error: "notFound" };
  if (existing.status !== PENDING) return { ok: false, error: "notPending" };

  const updated = await db.changeRequest.update({
    where: { id: changeRequestId },
    data: { status: decision, resolvedBy, resolvedAt: new Date() },
  });
  return { ok: true, changeRequest: updated };
}

// ─────────────────────────────────────────────────────────────────────────
// NEW_SESSION (M10, closing the gap flagged since M7): unlike NEW_CLASS, a
// session request carries everything a real `Session` needs — an *existing*
// `ClassGroup` already has its price and center-cut decided, so there is no
// missing-money problem to defer (contrast with the NEW_CLASS decision
// record above). Accepting therefore creates the `Session` immediately, the
// same "approve == act" shape M8's `confirmReservation` already established
// for `Reservation`.
// ─────────────────────────────────────────────────────────────────────────

type SessionRequestPayload = {
  classGroupId: string;
  date: string; // "YYYY-MM-DD"
  startTime: string;
  endTime: string;
};

export type ResolveSessionRequestResult =
  | { ok: true; changeRequest: ChangeRequest; session: Session | null; conflicts: ScheduleConflict[] }
  | {
      ok: false;
      error: "conflict" | "conflictsNeedConfirmation";
      conflicts: ScheduleConflict[];
    }
  | {
      ok: false;
      error: "notFound" | "notPending" | "classNotFound" | "duplicateSlot";
    };

/**
 * R3: accepting creates the session on the class's whole **room set**
 * (primary + a `SessionRoom` per extra) and applies the same confirmation
 * contract as every other slot write — DENY refuses, WARN refuses unless
 * `confirmConflicts` (then creates and audits the confirmation in the same
 * transaction). R4: `confirmConflicts` is required (there is no "omitted"
 * path any more), and a **deactivated** class takes no new session — the
 * request resolves as `classNotFound`, exactly like a class that is gone.
 */
export async function resolveSessionRequest(
  db: PrismaClient,
  centerId: string,
  changeRequestId: string,
  decision: Exclude<ChangeRequestStatus, "PENDING">,
  resolvedBy: string,
  conflictPolicy: ConflictPolicy,
  // Only labels a conflict for display (`ScheduleConflict.className`, M13).
  locale: string,
  options: { confirmConflicts: boolean; actorUserId?: string | null },
): Promise<ResolveSessionRequestResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.changeRequest.findFirst({
      where: scopedWhere(centerId, { id: changeRequestId, type: NEW_SESSION }),
    });
    if (!existing) return { ok: false, error: "notFound" };
    if (existing.status !== PENDING) return { ok: false, error: "notPending" };

    if (decision === "DECLINED") {
      const updated = await tx.changeRequest.update({
        where: { id: changeRequestId },
        data: { status: "DECLINED", resolvedBy, resolvedAt: new Date() },
      });
      return { ok: true, changeRequest: updated, session: null, conflicts: [] };
    }

    const payload = existing.payload as unknown as SessionRequestPayload;
    const classGroup = await tx.classGroup.findFirst({
      where: scopedWhere(centerId, { id: payload.classGroupId, active: true }),
      include: { extraRooms: { select: { roomId: true } } },
    });
    if (!classGroup) return { ok: false, error: "classNotFound" };
    const extraRoomIds = classGroup.roomId
      ? classGroup.extraRooms.map((extra) => extra.roomId)
      : [];

    const date = new Date(`${payload.date}T00:00:00.000Z`);
    const existingSessions = await loadSessionOccupancy(tx, centerId, locale, date, date);
    const conflicts = findSessionConflicts(
      {
        classGroupId: classGroup.id,
        teacherId: classGroup.teacherId,
        roomId: classGroup.roomId,
        roomIds: effectiveRoomIds(classGroup.roomId, extraRoomIds),
        date,
        startTime: payload.startTime,
        endTime: payload.endTime,
      },
      existingSessions,
    );
    const conflictDecision = decideConflicts(conflicts.length, conflictPolicy, options.confirmConflicts);
    if (conflictDecision === "denied") return { ok: false, error: "conflict", conflicts };
    if (conflictDecision === "needsConfirmation") {
      return { ok: false, error: "conflictsNeedConfirmation", conflicts };
    }

    let session: Session;
    try {
      session = await tx.session.create({
        data: scopedData(centerId, {
          classGroupId: classGroup.id,
          teacherId: classGroup.teacherId,
          roomId: classGroup.roomId,
          date,
          startTime: payload.startTime,
          endTime: payload.endTime,
          priceSnapshot: classGroup.price,
        }),
      });
    } catch (error) {
      if (
        error instanceof Object &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        return { ok: false, error: "duplicateSlot" };
      }
      throw error;
    }

    await writeSessionExtraRooms(tx, centerId, session.id, extraRoomIds);
    if (options.confirmConflicts) {
      await writeConfirmedConflictAudit(tx, {
        centerId,
        actorUserId: options.actorUserId ?? resolvedBy,
        entityType: "Session",
        entityId: session.id,
        context: "changeRequest.session.approve",
        conflicts,
      });
    }

    const updated = await tx.changeRequest.update({
      where: { id: changeRequestId },
      data: { status: "APPROVED", resolvedBy, resolvedAt: new Date() },
    });
    return { ok: true, changeRequest: updated, session, conflicts };
  });
}
