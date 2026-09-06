import type {
  Payment,
  PaymentMethod,
  Prisma,
  PrismaClient,
} from "@prisma/client";
// Relative import on purpose — `npm run check:payments` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/sessions.ts and lib/validation/classes.ts).
import { splitShare } from "../money.ts";

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
      error: "notFound" | "attendanceNotPayable" | "alreadyPaid";
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
 * - `centerShareSnapshot`/`teacherShareSnapshot` come from the class's
 *   *current* `centerShareType`/`centerShareValue` — read fresh, right now —
 *   because that split is being decided the moment this payment is
 *   recorded. A later change to the class's cut affects only payments
 *   recorded after that change (spec §7 acceptance criterion 3).
 * - "No debt" (spec §5): only PRESENT/LATE attendees are payable. An
 *   ABSENT/EXCUSED attendee is simply not counted — there is nothing to
 *   freeze a payment against.
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
  method: PaymentMethod,
  recordedBy: string,
): Promise<RecordPaymentResult> {
  const attendee = await tx.sessionAttendee.findFirst({
    where: { centerId, id: attendeeId },
    include: { session: { include: { classGroup: true } } },
  });
  if (!attendee || !attendee.studentProfileId) {
    return { ok: false, error: "notFound" };
  }
  if (
    attendee.attendanceStatus !== "PRESENT" &&
    attendee.attendanceStatus !== "LATE"
  ) {
    return { ok: false, error: "attendanceNotPayable" };
  }

  const existingActive = await tx.payment.findFirst({
    where: { centerId, sessionAttendeeId: attendeeId, voided: false },
  });
  if (existingActive) return { ok: false, error: "alreadyPaid" };

  const amount = attendee.session.priceSnapshot;
  const split = splitShare(
    amount,
    attendee.session.classGroup.centerShareType,
    attendee.session.classGroup.centerShareValue,
  );

  const payment = await tx.payment.create({
    data: {
      centerId,
      sessionId: attendee.sessionId,
      sessionAttendeeId: attendee.id,
      studentProfileId: attendee.studentProfileId,
      // Denormalized from the session for the M6 by-teacher analytics
      // groupBy (docs/02 §14) — not a money field, so it carries none of the
      // "never recompute" weight the share snapshots do.
      teacherId: attendee.session.teacherId,
      amount,
      method,
      priceSnapshot: amount,
      centerShareSnapshot: split.centerShare,
      teacherShareSnapshot: split.teacherShare,
      recordedBy,
    },
  });

  return { ok: true, payment };
}

export type VoidPaymentResult =
  | { ok: true; payment: Payment }
  | { ok: false; error: "notFound" | "alreadyVoided" };

/**
 * Voids a payment — never an `UPDATE` of its money fields (CLAUDE.md rule 2).
 * The row stays exactly as recorded; only `voided`/`voidReason`/`voidedAt`/
 * `voidedBy` change. The caller writes the `AuditLog` row (docs/01 §3,
 * CLAUDE.md rule 7) and may then call `recordPayment` again for the same
 * attendee — now allowed, since no active payment remains.
 */
export async function voidPayment(
  tx: Db,
  centerId: string,
  paymentId: string,
  reason: string,
  voidedBy: string,
): Promise<VoidPaymentResult> {
  const payment = await tx.payment.findFirst({
    where: { centerId, id: paymentId },
  });
  if (!payment) return { ok: false, error: "notFound" };
  if (payment.voided) return { ok: false, error: "alreadyVoided" };

  const updated = await tx.payment.update({
    where: { id: paymentId },
    data: {
      voided: true,
      voidReason: reason,
      voidedAt: new Date(),
      voidedBy,
    },
  });

  return { ok: true, payment: updated };
}

export type SessionReceiptTotals = {
  collected: number;
  centerShare: number;
  teacherShare: number;
  paidCount: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  excusedCount: number;
};

const EMPTY_STATUS_COUNTS = {
  PRESENT: 0,
  LATE: 0,
  ABSENT: 0,
  EXCUSED: 0,
} as const;

/**
 * The money + attendance summary a session receipt shows (spec §4.1 item 7,
 * docs/04 §5 "Receipt / money summary"): total collected, the center/teacher
 * split, and present/late/absent/excused counts. Reads only non-voided
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
    excusedCount: counts.EXCUSED,
  };
}
