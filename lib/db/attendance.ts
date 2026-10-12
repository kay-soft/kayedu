import { Prisma } from "@prisma/client";
import type {
  AttendanceStatus,
  Payment,
  PrismaClient,
  SessionAttendanceChange,
  SessionAttendee,
} from "@prisma/client";
// Relative imports on purpose — gates and the seed import this module
// directly, outside the Next.js runtime (docs/02 §5).
import {
  DEFAULT_TIMEZONE,
  checkInStatus,
  isSessionDayOver,
  resolveLateThreshold,
} from "../scheduling.ts";
import { voidPaymentRow } from "./payments.ts";
import {
  closeSessionIfDayOver,
  ensureSessionOpenOrAutoClose,
  loadGateSession,
  lockAttendeeRow,
  runInTransaction,
  SessionClosedError,
  type SessionClosedReason,
  type SessionWriteOptions,
} from "./session-lifecycle.ts";
import type { AdjustedSettlement } from "./settlements.ts";

/**
 * Roster / attendance writes (M5, spec §5 "Attendance"). Split out from
 * `lib/db/sessions.ts` (which owns session *metadata* — the dashboard, one
 * session's cancel/reschedule) because this module is specifically the write path CLAUDE.md
 * rule 7 requires an audit trail for: a first-time mark is "record", a
 * changed mark on an already-marked row is "correct" and must be audited.
 *
 * Every function here takes `centerId` explicitly and a Prisma client/tx
 * rather than going through `ScopedDb`, exactly like `lib/db/students.ts`'s
 * `claimStudentCode` — the money-adjacent write path (`recordPayment` in
 * `lib/db/payments.ts`) needs the same shape to share a transaction, and the
 * Server Action is what decides record-vs-correct permission *before*
 * calling in, using `findAttendee` below.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Existing roster row for (session, student), or null if never marked. */
export function findAttendee(
  db: Db,
  centerId: string,
  sessionId: string,
  studentProfileId: string,
): Promise<SessionAttendee | null> {
  return db.sessionAttendee.findFirst({
    where: { centerId, sessionId, studentProfileId },
  });
}

export function findAttendeeById(
  db: Db,
  centerId: string,
  id: string,
): Promise<SessionAttendee | null> {
  return db.sessionAttendee.findFirst({ where: { centerId, id } });
}

// The closed-session error and the guard live in lib/db/session-lifecycle.ts
// (R2) — the single owner of that rule. Re-exported so the M15 import path
// every Server Action already uses keeps working.
export { SessionClosedError } from "./session-lifecycle.ts";

export type CreateAttendanceOptions =
  | { now?: Date; historicalBackfill?: undefined; status?: undefined }
  | { now?: Date; historicalBackfill: true; status: AttendanceStatus };

/**
 * First-time mark — a check-in (`attendance.record`). `enrollmentId`/
 * `isDropIn` are resolved by the caller from the class's active enrollments
 * (docs/01 §1 principle 4 — the roster is decoupled from enrollment; drop-in
 * is simply `enrollmentId: null, isDropIn: true`).
 *
 * **The status is decided here, not by the caller (R2).** `checkInStatus`
 * (lib/scheduling.ts) compares now — in the centre's timezone — against the
 * session's start plus the class's `lateThresholdMinutes` (the centre's
 * `defaultLateThreshold` if the class has none): within it PRESENT, beyond it
 * LATE. No check-in surface offers a status picker; staff correct a wrong
 * mark afterwards from the roster, while the session is live. ABSENT is never
 * a check-in — it is what closing the session writes for enrolled no-shows.
 *
 * Refused (`SessionClosedError`) on a CANCELLED, rescheduled or closed
 * session; a session whose day ended is auto-closed by this very call first
 * (lib/db/session-lifecycle.ts). `historicalBackfill` — scripts only —
 * skips the closure check and takes an explicit status instead.
 */
export async function createAttendance(
  db: Db,
  params: {
    centerId: string;
    sessionId: string;
    studentProfileId: string;
    enrollmentId: string | null;
    isDropIn: boolean;
    recordedBy: string;
  },
  options: CreateAttendanceOptions = {},
): Promise<SessionAttendee> {
  const now = options.now ?? new Date();
  const session = await loadGateSession(db, params.centerId, params.sessionId);
  if (!session) throw new Error("createAttendance: session not found in this centre.");

  if (session.status === "CANCELLED") throw new SessionClosedError("sessionCancelled");
  if (session.rescheduledToId) throw new SessionClosedError("sessionRescheduled");

  let status: AttendanceStatus;
  if (options.historicalBackfill) {
    status = options.status;
  } else {
    if (session.closedAt) throw new SessionClosedError("sessionClosed");
    const tz = session.timezone ?? DEFAULT_TIMEZONE;
    if (isSessionDayOver(session.date, now, tz)) {
      // The day ended and nobody closed it: this touch closes it (AUTO,
      // absences materialized, committed) and the check-in is refused.
      await closeSessionIfDayOver(db, params.centerId, params.sessionId, now);
      throw new SessionClosedError("sessionClosed");
    }
    status = checkInStatus(
      session,
      resolveLateThreshold(session.classLateThresholdMinutes, session.defaultLateThreshold),
      now,
      tz,
    );
  }

  // One statement, atomic with the closure check: the row is inserted only
  // if the session is — at the moment the row lock is granted — still not
  // cancelled, rescheduled or (unless backfilling) closed. `FOR SHARE` makes
  // a concurrent "End session" (`FOR UPDATE`) and this insert serialize, and
  // Postgres re-evaluates the WHERE against the closed row if it had to wait,
  // so nothing slips in after a close. No interactive transaction: a rush of
  // check-ins holds a pooled connection for one statement each
  // (docs/02 §14, `npm run check:performance`).
  const openOnly = options.historicalBackfill ? Prisma.empty : Prisma.sql`AND s."closedAt" IS NULL`;
  const inserted = await db.$queryRaw<SessionAttendee[]>`
    INSERT INTO "SessionAttendee"
      ("id", "centerId", "sessionId", "studentProfileId", "enrollmentId",
       "attendanceStatus", "isDropIn", "recordedBy", "recordedAt", "updatedAt")
    SELECT gen_random_uuid()::text, s."centerId", s."id", ${params.studentProfileId},
       ${params.enrollmentId}, ${status}::"AttendanceStatus", ${params.isDropIn},
       ${params.recordedBy}, now(), now()
    FROM "Session" s
    WHERE s."id" = ${params.sessionId} AND s."centerId" = ${params.centerId}
      AND s."status" <> 'CANCELLED' AND s."rescheduledToId" IS NULL ${openOnly}
    FOR SHARE OF s
    RETURNING *`;
  if (inserted[0]) return inserted[0];

  // Lost a race with a cancel, reschedule or close between the read above
  // and the insert — report which one, in the M15 precedence.
  const after = await db.session.findFirst({
    where: { id: params.sessionId, centerId: params.centerId },
    select: { status: true, rescheduledToId: true },
  });
  if (after?.status === "CANCELLED") throw new SessionClosedError("sessionCancelled");
  if (after?.rescheduledToId) throw new SessionClosedError("sessionRescheduled");
  throw new SessionClosedError("sessionClosed");
}

export type ChangeAttendanceResult =
  | {
      ok: true;
      attendee: SessionAttendee;
      /** Null when the status did not actually change (nothing was written). */
      change: SessionAttendanceChange | null;
      /** The payment voided in this same transaction (PRESENT/LATE → ABSENT on a paid student). */
      voidedPayment: Payment | null;
      /** DRAFT/APPROVED settlements whose total that void live-adjusted (pre-R2 settlements only). */
      adjustedSettlements: AdjustedSettlement[];
    }
  | { ok: false; error: SessionClosedReason | "notFound" | "voidNotPermitted" };

/**
 * A changed mark on an already-marked row — the audited "correction"
 * (`attendance.correct`), allowed only while the session is live (R2).
 *
 * Every real change writes a `SessionAttendanceChange` row (the receipt's
 * "Changes during session" section). Switching a student who holds an
 * active (non-voided, non-refunded) payment to ABSENT **voids that payment
 * in this same transaction** (void, not refund — the payment should never
 * have stood, CLAUDE.md rule 7); `reason` is optional and lands on both the
 * void and the change row. If the void fails, nothing is written: the status
 * stays as it was. Moving ABSENT → PRESENT/LATE creates no payment — staff
 * record one through the normal flow. No money is created or recomputed by a
 * status change; lib/money.ts is not involved.
 *
 * `mayVoidPayment` is the caller's `payment.void` permission, re-checked here
 * under the row lock: a status change can never void money its actor could
 * not void directly. The change row and its audit rows (`attendance.correct`,
 * plus `payment.void` and any `settlement.adjust` when a payment was voided)
 * are written here, in the same transaction — all of it lands, or none of it.
 */
export async function changeAttendanceStatus(
  db: Db,
  params: {
    centerId: string;
    attendeeId: string;
    status: AttendanceStatus;
    changedBy: string;
    reason?: string | null;
    mayVoidPayment: boolean;
  },
  options: SessionWriteOptions = {},
): Promise<ChangeAttendanceResult> {
  const now = options.now ?? new Date();
  return runInTransaction(db, async (tx): Promise<ChangeAttendanceResult> => {
    const current = await tx.sessionAttendee.findFirst({
      where: { centerId: params.centerId, id: params.attendeeId },
    });
    if (!current || !current.studentProfileId) return { ok: false, error: "notFound" };

    const gate = await ensureSessionOpenOrAutoClose(tx, current.sessionId, params.centerId, now, {
      historicalBackfill: options.historicalBackfill,
    });
    if (gate.status === "missing") return { ok: false, error: "notFound" };
    if (gate.status === "refused") return { ok: false, error: gate.reason };

    // Row-lock this attendee (session share-lock first, then the attendee —
    // the order every attendee/payment write uses), then re-read: a
    // concurrent correction or payment on the same student serializes here.
    await lockAttendeeRow(tx, current.id);
    const attendee = await tx.sessionAttendee.findUniqueOrThrow({ where: { id: current.id } });
    const fromStatus = attendee.attendanceStatus;
    if (fromStatus === params.status) {
      return { ok: true, attendee, change: null, voidedPayment: null, adjustedSettlements: [] };
    }

    const reason = params.reason?.trim() ? params.reason.trim() : null;
    let voidedPayment: Payment | null = null;
    let adjustedSettlements: AdjustedSettlement[] = [];
    if (params.status === "ABSENT") {
      const active = await tx.payment.findFirst({
        where: {
          centerId: params.centerId,
          sessionAttendeeId: attendee.id,
          voided: false,
          refunded: false,
        },
      });
      if (active) {
        if (!params.mayVoidPayment) return { ok: false, error: "voidNotPermitted" };
        const voided = await voidPaymentRow(tx, params.centerId, active.id, reason, params.changedBy);
        // Anything but a clean void aborts the whole change (the throw rolls
        // the transaction back): the status never moves without its void.
        if (!voided.ok) throw new Error(`Void-on-absent failed: ${voided.error}`);
        voidedPayment = voided.payment;
        adjustedSettlements = voided.adjustedSettlements;
      }
    }

    const updated = await tx.sessionAttendee.update({
      where: { id: attendee.id },
      data: { attendanceStatus: params.status, recordedBy: params.changedBy, recordedAt: now },
    });
    const change = await tx.sessionAttendanceChange.create({
      data: {
        centerId: params.centerId,
        sessionId: attendee.sessionId,
        studentProfileId: current.studentProfileId,
        fromStatus,
        toStatus: params.status,
        voidedPaymentId: voidedPayment?.id ?? null,
        reason,
        changedBy: params.changedBy,
        changedAt: now,
      },
    });

    // The audit trail, in the same transaction as the change it records
    // (CLAUDE.md rule 7): `attendance.correct` always; `payment.void` and one
    // `settlement.adjust` per live-adjusted settlement when a payment was
    // voided. `SessionAttendanceChange` is the receipt's data source;
    // `AuditLog` stays the audit trail.
    await tx.auditLog.create({
      data: {
        centerId: params.centerId,
        actorUserId: params.changedBy,
        action: "attendance.correct",
        entityType: "SessionAttendee",
        entityId: attendee.id,
        before: { attendanceStatus: fromStatus },
        after: {
          attendanceStatus: params.status,
          reason,
          changeId: change.id,
          voidedPaymentId: change.voidedPaymentId,
        },
      },
    });
    if (voidedPayment) {
      await tx.auditLog.create({
        data: {
          centerId: params.centerId,
          actorUserId: params.changedBy,
          action: "payment.void",
          entityType: "Payment",
          entityId: voidedPayment.id,
          before: {
            amount: voidedPayment.amount,
            methodLabelSnapshot: voidedPayment.methodLabelSnapshot,
          },
          after: { reason, trigger: "attendance.absent", changeId: change.id },
        },
      });
      for (const { settlement, previousTotal } of adjustedSettlements) {
        await tx.auditLog.create({
          data: {
            centerId: params.centerId,
            actorUserId: params.changedBy,
            action: "settlement.adjust",
            entityType: "Settlement",
            entityId: settlement.id,
            before: { totalAmount: previousTotal },
            after: {
              totalAmount: settlement.totalAmount,
              reason: "payment.void",
              paymentId: voidedPayment.id,
            },
          },
        });
      }
    }

    return { ok: true, attendee: updated, change, voidedPayment, adjustedSettlements };
  });
}

/**
 * The M5-shaped correction call: the same choke point as
 * `changeAttendanceStatus` (it *is* that call, with the actor allowed to
 * void), returning the updated row and throwing `SessionClosedError` on a
 * cancelled/rescheduled/closed session. Scripts and gates use this shape.
 */
export async function updateAttendanceStatus(
  db: Db,
  existing: Pick<SessionAttendee, "id" | "centerId">,
  status: AttendanceStatus,
  recordedBy: string,
  options: SessionWriteOptions & { reason?: string | null } = {},
): Promise<SessionAttendee> {
  const result = await changeAttendanceStatus(
    db,
    {
      centerId: existing.centerId,
      attendeeId: existing.id,
      status,
      changedBy: recordedBy,
      reason: options.reason,
      mayVoidPayment: true,
    },
    options,
  );
  if (result.ok) return result.attendee;
  if (result.error === "notFound" || result.error === "voidNotPermitted") {
    throw new Error(`updateAttendanceStatus: ${result.error}`);
  }
  throw new SessionClosedError(result.error);
}

/**
 * How many of a student's most recent sessions *in this class*, counting
 * backwards from (and including) `uptoDate`, were marked ABSENT with no
 * PRESENT/LATE break in between (spec §7 acceptance criterion 13). With the
 * three statuses (R1) every non-ABSENT mark breaks the streak.
 * Capped at 50 rows — a real "in a row" alert never needs more, and this
 * keeps the query bounded without an unnecessary second round-trip to count.
 */
export async function consecutiveAbsenceCount(
  db: Db,
  centerId: string,
  classGroupId: string,
  studentProfileId: string,
  uptoDate: Date,
): Promise<number> {
  const rows = await db.sessionAttendee.findMany({
    where: {
      centerId,
      studentProfileId,
      session: { classGroupId, date: { lte: uptoDate } },
    },
    orderBy: { session: { date: "desc" } },
    select: { attendanceStatus: true },
    take: 50,
  });

  let count = 0;
  for (const row of rows) {
    if (row.attendanceStatus !== "ABSENT") break;
    count++;
  }
  return count;
}
