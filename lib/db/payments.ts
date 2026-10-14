import type {
  Payment,
  Prisma,
  PrismaClient,
} from "@prisma/client";
// Relative imports on purpose — `npm run check:payments` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/sessions.ts and lib/validation/classes.ts).
import { splitShare } from "../money.ts";
import { findActivePaymentMethod } from "./payment-methods.ts";
import {
  ensureSessionOpenOrAutoClose,
  loadGateSessionForAttendee,
  lockAttendeeRow,
  type SessionWriteOptions,
} from "./session-lifecycle.ts";
import {
  adjustUnpaidSettlementsForReversal,
  type AdjustedSettlement,
} from "./settlements.ts";

/**
 * The financial ledger's write path (M5, docs/01-data-model.md §3 — read that
 * section twice before touching this file). This is the ONLY place a
 * `Payment` row is created or voided; every action that touches money
 * (`app/[locale]/(center)/sessions/actions.ts`, `.../reception/actions.ts`)
 * calls in here rather than writing `prisma.payment.*` itself, so there is
 * exactly one place the snapshot math and the "one active payment per
 * attendee" rule can be gotten right or wrong.
 *
 * Both functions take a `Prisma.TransactionClient` — the caller wraps the
 * call in `prisma.$transaction()` (CLAUDE.md rule 2: "Payment" writes run
 * inside a transaction). `centerId` is taken explicitly rather than through
 * `ScopedDb`, exactly like `lib/db/students.ts`'s `claimStudentCode`, because
 * a transaction client isn't the app's scoped singleton.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type RecordPaymentResult =
  | { ok: true; payment: Payment }
  | {
      ok: false;
      error:
        | "notFound"
        | "attendanceNotPayable"
        | "alreadyPaid"
        | "sessionCancelled"
        | "sessionRescheduled"
        | "sessionClosed"
        | "invalidMethod"
        | "missingCut";
    };

/**
 * Records one session payment, freezing `priceSnapshot`,
 * `centerShareSnapshot` and `teacherShareSnapshot` at this exact instant
 * (docs/01 §3, CLAUDE.md rule 2) — never recomputed later even if the
 * class's price or center-cut changes afterwards.
 *
 * - `amount`/`priceSnapshot` come from `Session.priceSnapshot` — itself
 *   already frozen at session-generation time (docs/02 §11) — not from the
 *   class's *current* price, so a manager editing a class's price after
 *   sessions were generated cannot retroactively change what an
 *   already-materialized session charges.
 * - `centerShareSnapshot`/`teacherShareSnapshot` come from the session's own
 *   `centerShareType`/`centerShareValue` override when one is set (M13, spec
 *   §5.1 "Center cut" — "overridable per class and per session"), else from
 *   the class's *current* `centerShareType`/`centerShareValue` — read fresh,
 *   right now — because that split is being decided the moment this payment
 *   is recorded. A later change to the class's cut (or a session's override)
 *   affects only payments recorded after that change (spec §7 acceptance
 *   criterion 3).
 * - "No debt" (spec §5): only PRESENT/LATE attendees are payable. An
 *   ABSENT attendee is simply not counted — there is nothing to freeze a
 *   payment against.
 * - The method (R1) is resolved **inside this transaction**, filtered by
 *   `centerId` AND `active` — another centre's method id, or an inactive
 *   one, is refused as `invalidMethod` whatever the caller sent. Its name is
 *   frozen onto `methodLabelSnapshot` right here, so a later rename never
 *   relabels this payment.
 * - A closed session (R2) accepts no payment; a session whose day ended is
 *   auto-closed by this call first (lib/db/session-lifecycle.ts) and the
 *   payment is refused as `sessionClosed` — returned, not thrown, so the
 *   caller's transaction still commits the close.
 * - A **one-time session** (R5, no class) has no class cut to fall back to:
 *   its own `centerShareType` + `centerShareValue` are the cut, frozen here
 *   exactly like an override would be. If either is missing the payment is
 *   refused (`missingCut`) — money is never guessed at (CLAUDE.md rule 2).
 *   The split itself is still `lib/money.ts`'s, the only place it lives.
 * - At most one *active* (non-voided) payment exists per attendee at a time.
 *   `Payment.sessionAttendeeId` is deliberately not database-unique (see the
 *   schema comment) so a void-then-recreate leaves the voided row in place
 *   and adds a second — this function is what enforces "at most one active"
 *   instead.
 */
export async function recordPayment(
  tx: Db,
  centerId: string,
  attendeeId: string,
  paymentMethodId: string,
  recordedBy: string,
  options: SessionWriteOptions = {},
): Promise<RecordPaymentResult> {
  // One unlocked read carries everything this payment needs from the
  // session — the closure guard's own fields (passed to it as `peeked`, so it
  // costs no extra round trip) and the price/cut the payment freezes. The
  // money fields are read "right now", which is the instant the split is
  // decided (CLAUDE.md rule 2).
  const session = await loadGateSessionForAttendee(tx, centerId, attendeeId);
  if (!session) return { ok: false, error: "notFound" };

  // A cancelled session, one already superseded by a reschedule (M15, spec
  // §7 criterion 17 / §5.1 "Reschedule with linkage"), or a closed one (R2)
  // accepts no new payment — the one guard every write path shares
  // (lib/db/session-lifecycle.ts), which also row-locks the session so a
  // concurrent "End session" and this payment serialize.
  const gate = await ensureSessionOpenOrAutoClose(tx, session.id, centerId, options.now, {
    historicalBackfill: options.historicalBackfill,
    peeked: session,
  });
  if (gate.status === "missing") return { ok: false, error: "notFound" };
  if (gate.status === "refused") return { ok: false, error: gate.reason };

  // Lock this roster row (after the session's shared lock — the order every
  // attendee/payment write uses) and read, under that lock, the two facts a
  // concurrent write could change: the attendance status and whether an
  // active payment already exists. A correction to Absent or a second
  // payment for the same student serializes here.
  const roster = await lockAttendeeRow(tx, attendeeId, centerId);
  if (!roster || !roster.studentProfileId) return { ok: false, error: "notFound" };
  if (roster.attendanceStatus !== "PRESENT" && roster.attendanceStatus !== "LATE") {
    return { ok: false, error: "attendanceNotPayable" };
  }
  if (roster.hasActivePayment) return { ok: false, error: "alreadyPaid" };

  const method = await findActivePaymentMethod(tx, centerId, paymentMethodId);
  if (!method) return { ok: false, error: "invalidMethod" };

  const amount = session.priceSnapshot;
  // A session's own override (M13) wins when set; otherwise the class's
  // current cut. Both are read fresh, right now — this is the instant the
  // split is decided and frozen (CLAUDE.md rule 2). A one-time session (R5)
  // has no class: its own two fields ARE the cut, and both must be present.
  const cut =
    session.classGroupId === null
      ? { type: session.centerShareType, value: session.centerShareValue }
      : {
          type: session.centerShareType ?? session.classCenterShareType,
          value: session.centerShareValue ?? session.classCenterShareValue,
        };
  if (cut.type === null || cut.value === null) return { ok: false, error: "missingCut" };
  const split = splitShare(amount, cut.type, cut.value);

  const payment = await tx.payment.create({
    data: {
      centerId,
      sessionId: session.id,
      sessionAttendeeId: attendeeId,
      studentProfileId: roster.studentProfileId,
      // Denormalized from the session for the M6 by-teacher analytics
      // groupBy (docs/02 §14) — not a money field, so it carries none of the
      // "never recompute" weight the share snapshots do.
      teacherId: session.teacherId,
      amount,
      paymentMethodId: method.id,
      methodLabelSnapshot: method.name,
      priceSnapshot: amount,
      centerShareSnapshot: split.centerShare,
      teacherShareSnapshot: split.teacherShare,
      recordedBy,
    },
  });

  return { ok: true, payment };
}

export type VoidPaymentResult =
  | {
      ok: true;
      payment: Payment;
      /**
       * DRAFT/APPROVED settlements whose stored total had counted this
       * payment and were live-adjusted down in this same transaction — the
       * caller audits each as `settlement.adjust`. Only a pre-R2 settlement
       * can ever appear here (lib/db/settlements.ts's
       * `adjustUnpaidSettlementsForReversal`).
       */
      adjustedSettlements: AdjustedSettlement[];
    }
  | {
      ok: false;
      error: "notFound" | "alreadyVoided" | "alreadyRefunded" | "sessionClosed";
    };

/**
 * Voids a payment — never an `UPDATE` of its money fields (CLAUDE.md rule 2).
 * The row stays exactly as recorded; only `voided`/`voidReason`/`voidedAt`/
 * `voidedBy` change. The caller writes the `AuditLog` row (docs/01 §3,
 * CLAUDE.md rule 7) and may then call `recordPayment` again for the same
 * attendee — now allowed, since no active payment remains.
 *
 * R2: refused on a closed session (a closed session is an immutable record).
 * A CANCELLED or rescheduled session is *not* closed — undoing money it
 * already carries is exactly this function's job (docs/02 §11), so the guard
 * runs with `allowTerminal`. A refunded payment cannot also be voided: the
 * money already went back, and voiding it too would subtract it from revenue
 * a second time (void ≠ refund, never both on one row).
 */
export async function voidPayment(
  tx: Db,
  centerId: string,
  paymentId: string,
  reason: string | null,
  voidedBy: string,
  options: SessionWriteOptions = {},
): Promise<VoidPaymentResult> {
  const located = await tx.payment.findFirst({
    where: { centerId, id: paymentId },
    select: { sessionId: true },
  });
  if (!located) return { ok: false, error: "notFound" };

  const gate = await ensureSessionOpenOrAutoClose(tx, located.sessionId, centerId, options.now, {
    allowTerminal: true,
    historicalBackfill: options.historicalBackfill,
  });
  if (gate.status === "missing") return { ok: false, error: "notFound" };
  if (gate.status === "refused") return { ok: false, error: "sessionClosed" };

  return voidPaymentRow(tx, centerId, paymentId, reason, voidedBy);
}

/**
 * The void itself, for a caller that already holds the session open under
 * its lock — `voidPayment` above, and the void-on-absent inside
 * `lib/db/attendance.ts`'s `changeAttendanceStatus` (one void
 * implementation, two entry points). Also live-adjusts any unpaid
 * settlement whose total had counted this payment (R2 item 10, the same
 * rule a refund already followed since M14).
 */
export async function voidPaymentRow(
  tx: Db,
  centerId: string,
  paymentId: string,
  reason: string | null,
  voidedBy: string,
): Promise<VoidPaymentResult> {
  const payment = await tx.payment.findFirst({
    where: { centerId, id: paymentId },
    include: { session: { select: { date: true, closedAt: true } } },
  });
  if (!payment) return { ok: false, error: "notFound" };
  if (payment.voided) return { ok: false, error: "alreadyVoided" };
  if (payment.refunded) return { ok: false, error: "alreadyRefunded" };

  const updated = await tx.payment.update({
    where: { id: paymentId },
    data: {
      voided: true,
      voidReason: reason,
      voidedAt: new Date(),
      voidedBy,
    },
  });

  const adjustedSettlements = await adjustUnpaidSettlementsForReversal(
    tx,
    centerId,
    payment,
    payment.teacherShareSnapshot,
  );

  return { ok: true, payment: updated, adjustedSettlements };
}

export type SessionReceiptTotals = {
  collected: number;
  centerShare: number;
  teacherShare: number;
  paidCount: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
};

const EMPTY_STATUS_COUNTS = {
  PRESENT: 0,
  LATE: 0,
  ABSENT: 0,
} as const;

/**
 * The money + attendance summary a session receipt shows (spec §4.1 item 7,
 * docs/04 §5 "Receipt / money summary"): total collected, the center/teacher
 * split, and present/late/absent counts. Reads only non-voided
 * payments — a voided payment never contributes to "collected" again.
 */
export async function sessionReceiptTotals(
  db: Db,
  centerId: string,
  sessionId: string,
): Promise<SessionReceiptTotals> {
  const [paymentAgg, statusGroups] = await Promise.all([
    db.payment.aggregate({
      where: { centerId, sessionId, voided: false },
      _sum: { amount: true, centerShareSnapshot: true, teacherShareSnapshot: true },
      _count: true,
    }),
    db.sessionAttendee.groupBy({
      by: ["attendanceStatus"],
      where: { centerId, sessionId },
      _count: { attendanceStatus: true },
    }),
  ]);

  const counts: Record<keyof typeof EMPTY_STATUS_COUNTS, number> = {
    ...EMPTY_STATUS_COUNTS,
  };
  for (const group of statusGroups) {
    counts[group.attendanceStatus] = group._count.attendanceStatus;
  }

  return {
    collected: paymentAgg._sum.amount ?? 0,
    centerShare: paymentAgg._sum.centerShareSnapshot ?? 0,
    teacherShare: paymentAgg._sum.teacherShareSnapshot ?? 0,
    paidCount: paymentAgg._count,
    presentCount: counts.PRESENT,
    lateCount: counts.LATE,
    absentCount: counts.ABSENT,
  };
}
