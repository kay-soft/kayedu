import type {
  ConflictPolicy,
  Prisma,
  PrismaClient,
  Session,
  SessionStatus,
  ShareType,
} from "@prisma/client";

// Relative imports on purpose: `npm run check:classes` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/students.ts
// and lib/db/tenant-scope.ts). The Prisma client is *injected* rather than
// imported from lib/db/client.ts for the same reason — the gate script
// constructs its own `PrismaClient()`, the app passes the shared singleton.
import {
  dateKey,
  decideConflicts,
  findSessionConflicts,
  parseTimeToMinutes,
  startOfUtcDay,
  zonedClock,
  type ScheduleConflict,
} from "../scheduling.ts";
import { centerCutError } from "../money.ts";
import { effectiveRoomIds } from "../rooms.ts";
import {
  centerTimeZone,
  ensureSessionOpenOrAutoClose,
  runInTransaction,
  sessionTimeZone,
} from "./session-lifecycle.ts";
import { resolveRoomSet, writeSessionExtraRooms, type RoomSetError } from "./room-sets.ts";
import { loadSessionOccupancy, writeConfirmedConflictAudit } from "./slot-conflicts.ts";
import { CATALOG_OVERRIDE_SELECT } from "../catalog.ts";

/**
 * One session's own writes — cancel, reschedule, its centre-cut override,
 * its room set — plus the read-side session policy the dashboards share.
 *
 * R4: the rolling-window session generator that used to live here is gone.
 * A class's sessions are created, re-fitted and removed by exactly one
 * module, `lib/db/class-sessions.ts`, from the class's own period.
 */

/**
 * The R3 confirmation contract, as every slot-writing function takes it.
 * `confirmConflicts` is what the person ticked ("I understand, create
 * anyway"). **Required since R4** — there is no default and no "omitted
 * means save" script path any more: a caller that does not pass it does
 * not compile. `actorUserId` attributes the confirmation's audit row.
 */
export type ConflictConfirmation = {
  confirmConflicts: boolean;
  actorUserId?: string | null;
};

/** A dated double-booking: the clash plus the "YYYY-MM-DD" it happens on. */
export type DatedConflict = ScheduleConflict & { date: string };

// ─────────────────────────────────────────────────────────────────────────
// The one-time-session invariant (R5). "The kind says which fields apply",
// the same application-layer style `Settlement` and `CenterCatalogSelection`
// use: a session with no class must carry its own title, teacher, price and
// BOTH halves of its centre cut, because there is no class to inherit any of
// them from. Enforced here — by every writer that could produce or clear one
// of these fields — and asserted by `npm run check:one-off-sessions`.
// ─────────────────────────────────────────────────────────────────────────

export type OneOffShapeError = "titleRequired" | "teacherRequired" | "priceRequired" | "cutRequired";

export function oneOffSessionShapeError(session: {
  classGroupId: string | null;
  title: string | null;
  teacherId: string | null;
  priceSnapshot: number | null;
  centerShareType: ShareType | null;
  centerShareValue: number | null;
}): OneOffShapeError | null {
  if (session.classGroupId !== null) return null;
  if (!session.title || session.title.trim().length === 0) return "titleRequired";
  if (!session.teacherId) return "teacherRequired";
  if (session.priceSnapshot === null || !Number.isInteger(session.priceSnapshot) || session.priceSnapshot < 0) {
    return "priceRequired";
  }
  if (session.centerShareType === null || session.centerShareValue === null) return "cutRequired";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Session lifecycle: cancel / reschedule (M10, spec §7 acceptance criterion
// 11, closing the gap flagged since M5/docs §11: "Cancel/reschedule/edit of
// an individual session is not yet built"). No `@/` imports, for the same
// reason as the rest of this module (docs/02 §5).
// ─────────────────────────────────────────────────────────────────────────

type SessionDb = PrismaClient | Prisma.TransactionClient;

const CANCELLED_ENUM: SessionStatus = "CANCELLED";

export type CancelSessionResult =
  | { ok: true; session: Session }
  | {
      ok: false;
      error: "notFound" | "alreadyCancelled" | "alreadyRescheduled" | "sessionClosed" | "hasPayments";
    };

/**
 * Payments that still stand on a session — neither voided nor refunded. Read
 * under the session's exclusive lock, so a payment in flight (which holds the
 * shared lock) has either committed and is counted, or waits behind it.
 */
async function activePaymentCount(tx: Prisma.TransactionClient, centerId: string, sessionId: string) {
  return tx.payment.count({ where: { centerId, sessionId, voided: false, refunded: false } });
}

/**
 * Cancels one session. Money is never touched here (CLAUDE.md rule 2) —
 * a cancelled session's existing attendance rows stay exactly as recorded.
 * "Roster and schedule update correctly" (spec §7 criterion 11) is true by
 * construction: `SessionAttendee` rows are never deleted, and
 * `deriveSessionDisplayStatus` already treats `CANCELLED` as terminal
 * regardless of the clock.
 *
 * **Refused while the session holds an active payment (SEC-2b, D-07 (c),
 * SEC-08)** — `hasPayments`: staff void or refund first, each audited with its
 * reason, then cancel. A cancelled session then closes at the end of its day
 * and refuses every money write, so a cancelled day's cash can never be edited
 * months later. A refunded payment does not block (its money is already back).
 *
 * R2: a closed session cannot be cancelled (`sessionClosed`) — it ran, and
 * its record is final. A session whose day ended is auto-closed by this call
 * first (lib/db/session-lifecycle.ts), then refused.
 */
export async function cancelSession(
  db: SessionDb,
  centerId: string,
  sessionId: string,
  options: { now?: Date } = {},
): Promise<CancelSessionResult> {
  return runInTransaction(db, async (tx): Promise<CancelSessionResult> => {
    const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, options.now, {
      allowTerminal: true,
      exclusive: true,
    });
    if (gate.status === "missing") return { ok: false, error: "notFound" };
    if (gate.status === "refused") return { ok: false, error: "sessionClosed" };
    if (gate.session.status === CANCELLED_ENUM) return { ok: false, error: "alreadyCancelled" };
    if (gate.session.rescheduledToId) return { ok: false, error: "alreadyRescheduled" };
    if ((await activePaymentCount(tx, centerId, sessionId)) > 0) return { ok: false, error: "hasPayments" };

    const updated = await tx.session.update({
      where: { id: sessionId },
      data: { status: CANCELLED_ENUM },
    });
    return { ok: true, session: updated };
  });
}

export type UpdateSessionShareOverrideResult =
  | { ok: true; session: Session }
  | { ok: false; error: "notFound" | "sessionClosed" | "cutRequired" | "fixedAbovePrice" | "invalidCut" };

/**
 * Sets or clears this one session's centre-cut override (M13, spec §5.1
 * "Center cut" — "overridable per class and per session"). `null` clears the
 * override back to "inherit the class's own centerShareType/
 * centerShareValue" — every session's state until this is called. Only
 * consulted by `recordPayment` at the moment a payment is frozen; never
 * touches an already-recorded payment's snapshots (CLAUDE.md rule 2).
 *
 * R2: refused on a closed session (`sessionClosed`) — no payment can be
 * recorded there any more, so an override would only rewrite its record.
 *
 * R5: on a one-time session the two fields are not an override but the
 * session's only cut, so clearing them is refused (`cutRequired`) — the
 * invariant above, enforced at the one writer that could break it. Changing
 * them to another valid cut is allowed, exactly as for a class session.
 *
 * SEC-2b (D-15): a FIXED cut above this session's own price is refused
 * (`fixedAbovePrice`) — it would silently give the teacher 0 on every payment.
 */
export async function updateSessionShareOverride(
  db: SessionDb,
  centerId: string,
  sessionId: string,
  override: { centerShareType: ShareType; centerShareValue: number } | null,
  options: { now?: Date } = {},
): Promise<UpdateSessionShareOverrideResult> {
  return runInTransaction(db, async (tx): Promise<UpdateSessionShareOverrideResult> => {
    const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, options.now, {
      allowTerminal: true,
      exclusive: true,
    });
    if (gate.status === "missing") return { ok: false, error: "notFound" };
    if (gate.status === "refused") return { ok: false, error: "sessionClosed" };
    if (gate.session.classGroupId === null && override === null) {
      return { ok: false, error: "cutRequired" };
    }
    if (override) {
      const cutError = centerCutError(gate.session.priceSnapshot, override.centerShareType, override.centerShareValue);
      if (cutError === "fixedAbovePrice") return { ok: false, error: "fixedAbovePrice" };
      if (cutError) return { ok: false, error: "invalidCut" };
    }

    const updated = await tx.session.update({
      where: { id: sessionId },
      data: {
        centerShareType: override?.centerShareType ?? null,
        centerShareValue: override?.centerShareValue ?? null,
      },
    });
    return { ok: true, session: updated };
  });
}

/**
 * A slot write refused over conflicts. `conflict` is DENY (refused whatever
 * the flag says); `conflictsNeedConfirmation` is WARN without
 * `confirmConflicts` (R3). Both carry the conflict list — never a generic
 * error — so the form can show exactly what clashes.
 */
export type ConflictRefusal = {
  ok: false;
  error: "conflict" | "conflictsNeedConfirmation";
  conflicts: DatedConflict[];
};

export type RescheduleSessionResult =
  | { ok: true; session: Session; conflicts: DatedConflict[] }
  | ConflictRefusal
  | {
      ok: false;
      error:
        | "notFound"
        | "cancelled"
        | "alreadyRescheduled"
        | "sessionClosed"
        | "duplicateSlot"
        | "pastDate"
        | "hasPayments"
        | RoomSetError;
    };

/**
 * Moves one session to a new date/time — same-day at a different time, or a
 * future date (M15, spec §5.1 "Reschedule with linkage"). Unlike the pre-M15
 * behavior, the original row is never mutated in place: a **new** `Session`
 * is created at the target date/time and the original's `rescheduledToId` is
 * written immediately, so history reads "this session moved to that one"
 * rather than "this session was always on Thursday" — the original keeps
 * whatever attendance/payments it already carries, untouched (CLAUDE.md rule
 * 2), and is closed to any *new* attendance/payment from that point on
 * (`lib/db/attendance.ts`/`lib/db/payments.ts`'s `sessionRescheduled` guard).
 * Identical rule whether a teacher or centre staff initiates it — this
 * function has no caller-identity branch at all.
 *
 * R3: the replacement takes the original's **room set** (primary + extras)
 * unless `next.roomId`/`next.extraRoomIds` choose another one, which must be
 * a valid combination (`lib/db/room-sets.ts`'s `resolveRoomSet`). The
 * teacher/room conflict check (`findSessionConflicts`, docs/02 §11) is the
 * same one every slot write uses, over the whole room set: `timeRangesOverlap`
 * compares the full start→end window, not just the start instant, so a
 * target slot free at its start but busy before it ends is still flagged.
 * DENY refuses; WARN refuses unless `confirmConflicts` (then saves and
 * audits the confirmation). `findSessionConflicts` already skips the
 * session's own class, so the moved session never "conflicts with itself"
 * (and the original slot it vacates occupies nothing once linked).
 *
 * The `(classGroupId, date, startTime)` unique constraint still applies to
 * the new row — if this class already has another session at the target
 * slot, the write fails with `duplicateSlot` rather than silently merging
 * two sessions.
 *
 * R2: a closed session cannot be rescheduled (`sessionClosed`); the closure
 * guard runs inside the same transaction as the write, so a session that
 * closes between the conflict check and the write is still refused.
 *
 * SEC-2b: the target is **never in the past** (`pastDate`, SEC-51 — the same
 * "today or later, in the centre's timezone" rule a manual session follows;
 * a time earlier today is allowed), and a session holding an active payment
 * cannot be moved (`hasPayments`, D-07 (c)) — staff void or refund first.
 */
export async function rescheduleSession(
  db: PrismaClient,
  centerId: string,
  sessionId: string,
  next: {
    date: Date;
    startTime: string;
    endTime: string;
    /** R3 — omitted: copy the original's room set. */
    roomId?: string | null;
    extraRoomIds?: string[];
  },
  conflictPolicy: ConflictPolicy,
  // Only labels a conflict for display (`ScheduleConflict.className`, M13).
  locale: string,
  options: { now?: Date } & ConflictConfirmation,
): Promise<RescheduleSessionResult> {
  const session = await db.session.findFirst({
    where: { centerId, id: sessionId },
    include: { extraRooms: { select: { roomId: true } } },
  });
  if (!session) return { ok: false, error: "notFound" };
  if (session.status === CANCELLED_ENUM) return { ok: false, error: "cancelled" };
  if (session.rescheduledToId) return { ok: false, error: "alreadyRescheduled" };
  if (session.closedAt) return { ok: false, error: "sessionClosed" };
  const centreZone = await centerTimeZone(db, centerId);
  if (dateKey(next.date) < zonedClock(options.now ?? new Date(), centreZone).dayKey) {
    return { ok: false, error: "pastDate" };
  }

  // The room set: the original's by default, or a newly chosen valid one.
  let roomId = session.roomId;
  let extraRoomIds = session.roomId ? session.extraRooms.map((extra) => extra.roomId) : [];
  if (next.roomId !== undefined) {
    const keep = effectiveRoomIds(roomId, extraRoomIds);
    const resolved = await resolveRoomSet(db, centerId, next.roomId, next.extraRoomIds ?? [], {
      requireActiveExcept: keep,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    roomId = next.roomId;
    extraRoomIds = next.roomId ? [...(next.extraRoomIds ?? [])] : [];
  }

  const existing = await loadSessionOccupancy(
    db,
    centerId,
    locale,
    startOfUtcDay(next.date),
    startOfUtcDay(next.date),
  );

  const found = findSessionConflicts(
    {
      classGroupId: session.classGroupId,
      // R5: a one-time session has no class to skip; the slot it vacates
      // must still never count as a clash with its own replacement.
      excludeSessionId: session.id,
      teacherId: session.teacherId,
      roomId,
      roomIds: effectiveRoomIds(roomId, extraRoomIds),
      date: next.date,
      startTime: next.startTime,
      endTime: next.endTime,
    },
    existing,
  );
  const conflicts: DatedConflict[] = found.map((conflict) => ({
    ...conflict,
    date: dateKey(next.date),
  }));

  const decision = decideConflicts(conflicts.length, conflictPolicy, options.confirmConflicts);
  if (decision === "denied") return { ok: false, error: "conflict", conflicts };
  if (decision === "needsConfirmation") {
    return { ok: false, error: "conflictsNeedConfirmation", conflicts };
  }

  try {
    // One transaction: the new occurrence and the original's linkage are
    // written together, or not at all — never a replacement with no session
    // pointing at it, or a link to a replacement that doesn't exist.
    const outcome = await runInTransaction(db, async (tx) => {
      // The closure guard, inside the write's own transaction (R2). A refusal
      // is returned, not thrown, so a lazy end-of-day close still commits.
      const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, options.now, {
        allowTerminal: true,
        exclusive: true,
      });
      if (gate.status !== "open") return null;
      if (gate.session.status === CANCELLED_ENUM || gate.session.rescheduledToId) return null;
      if ((await activePaymentCount(tx, centerId, sessionId)) > 0) return "hasPayments" as const;

      const created = await tx.session.create({
        data: {
          centerId,
          classGroupId: session.classGroupId,
          teacherId: session.teacherId,
          roomId,
          date: next.date,
          startTime: next.startTime,
          endTime: next.endTime,
          priceSnapshot: session.priceSnapshot,
          centerShareType: session.centerShareType,
          centerShareValue: session.centerShareValue,
          description: session.description,
          // R5: the replacement is the same kind of session as the original —
          // a one-time session keeps its title, subject, grade and own cut
          // (the invariant), and a manual one stays manual.
          title: session.title,
          subjectId: session.subjectId,
          gradeId: session.gradeId,
          isManual: session.isManual,
        },
      });
      await writeSessionExtraRooms(tx, centerId, created.id, extraRoomIds);
      await tx.session.update({
        where: { id: sessionId },
        data: { rescheduledToId: created.id },
      });
      if (options.confirmConflicts) {
        await writeConfirmedConflictAudit(tx, {
          centerId,
          actorUserId: options.actorUserId ?? null,
          entityType: "Session",
          entityId: created.id,
          context: "session.reschedule",
          conflicts,
        });
      }
      return created;
    });
    if (!outcome) return { ok: false, error: "sessionClosed" };
    if (outcome === "hasPayments") return { ok: false, error: "hasPayments" };
    return { ok: true, session: outcome, conflicts };
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
}

export type UpdateSessionRoomsResult =
  | { ok: true; session: Session; conflicts: DatedConflict[] }
  | ConflictRefusal
  | {
      ok: false;
      error: "notFound" | "cancelled" | "alreadyRescheduled" | "sessionClosed" | RoomSetError;
    };

/**
 * Changes the room set of **one session only** (R3 — "the session edit
 * control can pick a primary room plus linked extras for that session").
 * Never touches the class, so it never changes the class's enrolment cap;
 * it changes which rooms this session keeps busy and the seat count shown
 * for it. The same combination rule and the same conflict contract as every
 * other slot write: DENY refuses, WARN refuses unless `confirmConflicts`
 * (then saves and audits). A cancelled, rescheduled or closed session is
 * refused — its record is final.
 */
export async function updateSessionRooms(
  db: PrismaClient,
  centerId: string,
  sessionId: string,
  next: { roomId: string | null; extraRoomIds: string[] },
  conflictPolicy: ConflictPolicy,
  locale: string,
  options: { now?: Date } & ConflictConfirmation,
): Promise<UpdateSessionRoomsResult> {
  const session = await db.session.findFirst({
    where: { centerId, id: sessionId },
    include: { extraRooms: { select: { roomId: true } } },
  });
  if (!session) return { ok: false, error: "notFound" };
  if (session.status === CANCELLED_ENUM) return { ok: false, error: "cancelled" };
  if (session.rescheduledToId) return { ok: false, error: "alreadyRescheduled" };
  if (session.closedAt) return { ok: false, error: "sessionClosed" };

  const current = effectiveRoomIds(
    session.roomId,
    session.extraRooms.map((extra) => extra.roomId),
  );
  const resolved = await resolveRoomSet(db, centerId, next.roomId, next.extraRoomIds, {
    requireActiveExcept: current,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const extraRoomIds = next.roomId ? next.extraRoomIds : [];

  const existing = await loadSessionOccupancy(db, centerId, locale, session.date, session.date);
  const conflicts: DatedConflict[] = findSessionConflicts(
    {
      classGroupId: session.classGroupId,
      excludeSessionId: session.id,
      teacherId: session.teacherId,
      roomId: next.roomId,
      roomIds: resolved.set.roomIds,
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
    },
    existing,
  ).map((conflict) => ({ ...conflict, date: dateKey(session.date) }));

  const decision = decideConflicts(conflicts.length, conflictPolicy, options.confirmConflicts);
  if (decision === "denied") return { ok: false, error: "conflict", conflicts };
  if (decision === "needsConfirmation") {
    return { ok: false, error: "conflictsNeedConfirmation", conflicts };
  }

  const outcome = await runInTransaction(db, async (tx) => {
    const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, options.now, {
      allowTerminal: true,
      exclusive: true,
    });
    if (gate.status !== "open") return null;
    if (gate.session.status === CANCELLED_ENUM || gate.session.rescheduledToId) return null;

    const updated = await tx.session.update({
      where: { id: sessionId },
      data: { roomId: next.roomId },
    });
    await writeSessionExtraRooms(tx, centerId, sessionId, extraRoomIds);
    if (options.confirmConflicts) {
      await writeConfirmedConflictAudit(tx, {
        centerId,
        actorUserId: options.actorUserId ?? null,
        entityType: "Session",
        entityId: sessionId,
        context: "session.rooms.update",
        conflicts,
      });
    }
    return updated;
  });
  if (!outcome) return { ok: false, error: "sessionClosed" };
  return { ok: true, session: outcome, conflicts };
}

// ─────────────────────────────────────────────────────────────────────────
// Read-side session policy (Today's Sessions dashboard + detail, M5).
// Kept in this file — not lib/db/classes.ts or lib/db/scoped.ts — because
// `npm run check:classes` imports this module directly outside the Next.js
// runtime, so everything here stays free of `@/` aliases the same way
// (docs/02-architecture.md §5).
// ─────────────────────────────────────────────────────────────────────────

const CANCELLED_STATUS: SessionStatus = "CANCELLED";
const ACTIVE_ENROLLMENT_STATUS = "ACTIVE" as const;

/**
 * Fields a Today's Sessions dashboard row renders — never a full include.
 * A function of `centerId`, not a static object (M13): `subject`/`grade`
 * each carry a nested, centre-scoped `selections` lookup so the label shown
 * resolves this centre's own rename when it has one — no schema field
 * freezes a catalog entry's name, so every live read resolves the override.
 */
export function sessionListSelect(centerId: string) {
  return {
    id: true,
    date: true,
    startTime: true,
    endTime: true,
    status: true,
    rescheduledToId: true,
    closedAt: true,
    priceSnapshot: true,
    teacherId: true,
    classGroupId: true,
    // D-14 — the session's own frozen timezone (its display status uses it).
    timezone: true,
    // R5 — a one-time session's own name; `isManual` badges an extra session.
    title: true,
    isManual: true,
    subject: {
      select: {
        nameAr: true,
        nameEn: true,
        selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
      },
    },
    grade: {
      select: {
        nameAr: true,
        nameEn: true,
        selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
      },
    },
    classGroup: {
      select: {
        subject: {
          select: {
            nameAr: true,
            nameEn: true,
            selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
          },
        },
        grade: {
          select: {
            nameAr: true,
            nameEn: true,
            selections: { where: { centerId }, select: CATALOG_OVERRIDE_SELECT, take: 1 },
          },
        },
        _count: { select: { enrollments: { where: { status: ACTIVE_ENROLLMENT_STATUS } } } },
      },
    },
    room: { select: { id: true, name: true, capacity: true } },
    // R3 — rooms combined with the primary for this session.
    extraRooms: {
      select: { room: { select: { id: true, name: true, capacity: true } } },
      orderBy: { createdAt: "asc" },
    },
    _count: { select: { attendees: true } },
  } satisfies Prisma.SessionSelect;
}

/** A session detail page — every field it renders, including the roster. */
export function sessionDetailInclude(centerId: string) {
  const withSelection = { include: { selections: { where: { centerId } } } } as const;
  return {
    teacher: true,
    room: true,
    extraRooms: { include: { room: true }, orderBy: { createdAt: "asc" } },
    // Null on a one-time session (R5) — its own subject/grade below label it.
    classGroup: { include: { subject: withSelection, grade: withSelection } },
    subject: withSelection,
    grade: withSelection,
    attendees: {
      include: {
        studentProfile: { include: { user: true } },
        enrollment: true,
        payments: { orderBy: { recordedAt: "desc" } },
      },
      orderBy: { createdAt: "asc" },
    },
  } satisfies Prisma.SessionInclude;
}

export function sessionListWhere(filters: {
  from: Date;
  to: Date;
  teacherId?: string | null;
  subjectId?: string | null;
  classGroupId?: string | null;
}): Prisma.SessionWhereInput {
  const where: Prisma.SessionWhereInput = {
    date: { gte: filters.from, lte: filters.to },
  };
  if (filters.teacherId) where.teacherId = filters.teacherId;
  if (filters.classGroupId) where.classGroupId = filters.classGroupId;
  // A class session's subject is its class's; a one-time session's is its own (R5).
  if (filters.subjectId) {
    where.OR = [
      { classGroup: { subjectId: filters.subjectId } },
      { classGroupId: null, subjectId: filters.subjectId },
    ];
  }
  return where;
}

export type SessionDisplayStatus =
  | "SCHEDULED"
  | "LIVE"
  | "COMPLETED"
  | "CANCELLED"
  | "RESCHEDULED";

/**
 * The status a session *displays*. Precedence, highest first:
 * - RESCHEDULED (M15) — derived from `rescheduledToId`, not stored: the
 *   original is neither cancelled (it still happens, on its replacement) nor
 *   SCHEDULED/COMPLETED by the clock (its own slot never occurred).
 * - CANCELLED — the stored value, terminal regardless of the clock.
 * - COMPLETED — the session is **closed** (R2): `closedAt` set (which also
 *   stores `status: COMPLETED`), or its calendar day has ended in the
 *   centre's timezone (it is closed AUTO on its next touch —
 *   lib/db/session-lifecycle.ts). Stored and displayed status agree.
 * - SCHEDULED — its start time has not come yet, in the centre's timezone.
 * - LIVE — started and not closed. A session stays LIVE past its end time
 *   until staff end it or its day ends, because until then it still accepts
 *   attendance corrections and payments; "Live" is what tells staff it is
 *   still open.
 *
 * `date` is a UTC-midnight calendar-day marker and `startTime` a bare
 * "HH:MM" wall-clock string in the session's timezone — its own frozen one
 * when the row carries it (SEC-2b, D-14), else `timeZone` (the centre's) — so
 * `now` is read through `zonedClock` (lib/scheduling.ts), never in UTC.
 */
export function deriveSessionDisplayStatus(
  session: {
    status: SessionStatus;
    date: Date;
    startTime: string;
    endTime: string;
    rescheduledToId?: string | null;
    closedAt?: Date | null;
    timezone?: string | null;
  },
  now: Date,
  timeZone: string,
): SessionDisplayStatus {
  if (session.rescheduledToId) return "RESCHEDULED";
  if (session.status === CANCELLED_STATUS) return "CANCELLED";
  if (session.closedAt || session.status === "COMPLETED") return "COMPLETED";

  const clock = zonedClock(now, sessionTimeZone(session, timeZone));
  const dayKey = dateKey(session.date);
  if (dayKey > clock.dayKey) return "SCHEDULED";
  if (dayKey < clock.dayKey) return "COMPLETED";
  if (clock.minutes < parseTimeToMinutesSafe(session.startTime)) return "SCHEDULED";
  return "LIVE";
}

function parseTimeToMinutesSafe(value: string): number {
  try {
    return parseTimeToMinutes(value);
  } catch {
    const [hours, minutes] = value.split(":").map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }
}
