import type { Payment, Prisma, PrismaClient, Refund } from "@prisma/client";
// Relative imports on purpose — `npm run check:settlements` exercises this
// module directly, outside the Next.js runtime.
import { lockPaymentRow } from "./payments.ts";
import {
  ensureSessionOpenOrAutoClose,
  type SessionWriteOptions,
} from "./session-lifecycle.ts";
import {
  adjustUnpaidSettlementsForReversal,
  type AdjustedSettlement,
} from "./settlements.ts";

/**
 * Refunds (M14, docs/01-data-model.md "Finance-adjacent layer"). This is the
 * ONLY place a `Refund` row is created — a pure reader/deriver of the
 * existing frozen ledger, never a writer of `Payment`'s money fields
 * (CLAUDE.md rule 2). Cash back to the student, no balance created anywhere
 * (spec §2 "Student debt" is unchanged).
 *
 * Takes a `Prisma.TransactionClient` exactly like `lib/db/payments.ts`'s
 * `recordPayment`/`voidPayment` — the caller wraps the call in
 * `prisma.$transaction()`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type RefundPaymentResult =
  | {
      ok: true;
      refund: Refund;
      payment: Payment;
      /**
       * Every DRAFT/APPROVED settlement that already claimed this payment's
       * teacher share, each with its total live-adjusted downward in this
       * same transaction (M14 follow-up, 00-master-product-spec.md §5
       * "Teacher settlements") — the caller audits each one as
       * `settlement.adjust`. A PAID settlement is never adjusted and never
       * appears here; see the `Settlement` schema comment.
       */
      adjustedSettlements: AdjustedSettlement[];
    }
  | {
      ok: false;
      error:
        | "notFound"
        | "alreadyVoided"
        | "alreadyRefunded"
        | "reasonRequired"
        | "sessionClosed"
        | "sessionCancelled"
        | "sessionRescheduled";
    };

/**
 * Refunds one payment in full — Phase 1 supports whole-payment refunds only
 * (spec §4.1 item 12: "marking a recorded payment REFUNDED"), so the
 * reversal amounts are always exactly the payment's own frozen `amount`/
 * `centerShareSnapshot`/`teacherShareSnapshot`, never recomputed or
 * partial. The original `Payment` row's money fields are never written —
 * only `refunded` flips to `true` so a reader sees the state without a join
 * (docs/01 §2 "Finance-adjacent layer").
 *
 * A voided payment was never real revenue, so it cannot be refunded (there
 * is nothing to give back); an already-refunded payment cannot be refunded
 * twice — both refuse rather than silently no-op, the same shape
 * `voidPayment` uses for `alreadyVoided`.
 *
 * A payment can outlive being claimed by a settlement that has not paid out
 * yet (spec §5 "Teacher settlements" — a centre could refund a student
 * between drafting a payout and actually paying it). Without a correction, a
 * centre would pay a teacher's share on money the student already got back.
 * So this function also finds every DRAFT/APPROVED settlement in this
 * payment's scope (its own session, or a period covering its session's
 * date, for the same teacher) and subtracts this refund's
 * `teacherShareReversed` from each one's `totalAmount`, right here in the
 * same transaction — a settlement is never left silently wrong while it can
 * still be corrected. Once a settlement is PAID, the money has left the
 * centre, so it is excluded from this query entirely and never rewritten;
 * the loss (or its recovery from the teacher) is handled outside this
 * record, exactly as the void/refund table already says for a PAID
 * settlement. Which settlements had actually counted this payment is
 * decided by `adjustUnpaidSettlementsForReversal` (lib/db/settlements.ts),
 * the one rule a void (R2) follows too.
 *
 * R2: refused on a closed session (`sessionClosed`) — a closed session is an
 * immutable record. SEC-2b (D-07): refused on a CANCELLED or rescheduled
 * session too — neither can be cancelled/rescheduled while it holds active
 * money, so there is nothing there to give back.
 *
 * SEC-12: the payment row is locked and re-read before anything is decided,
 * and the flag flips conditionally — a refund racing a void (or a second
 * refund) serializes here, and the loser gets `alreadyVoided`/
 * `alreadyRefunded`, never a second write and never a thrown unique error.
 */
export async function refundPayment(
  tx: Db,
  centerId: string,
  paymentId: string,
  reason: string,
  refundedBy: string,
  options: SessionWriteOptions = {},
): Promise<RefundPaymentResult> {
  if (reason.trim().length === 0) return { ok: false, error: "reasonRequired" };
  const located = await tx.payment.findFirst({
    where: { centerId, id: paymentId },
    select: { sessionId: true },
  });
  if (!located) return { ok: false, error: "notFound" };
  const gate = await ensureSessionOpenOrAutoClose(tx, located.sessionId, centerId, options.now, {
    historicalBackfill: options.historicalBackfill,
  });
  if (gate.status === "missing") return { ok: false, error: "notFound" };
  if (gate.status === "refused") return { ok: false, error: gate.reason };

  const payment = await lockPaymentRow(tx, centerId, paymentId);
  if (!payment) return { ok: false, error: "notFound" };
  if (payment.voided) return { ok: false, error: "alreadyVoided" };
  if (payment.refunded) return { ok: false, error: "alreadyRefunded" };

  const flipped = await tx.payment.updateMany({
    where: { id: payment.id, centerId, voided: false, refunded: false },
    data: { refunded: true },
  });
  if (flipped.count !== 1) return { ok: false, error: "alreadyRefunded" };
  const refund = await tx.refund.create({
    data: {
      centerId,
      paymentId: payment.id,
      teacherId: payment.teacherId,
      amount: payment.amount,
      centerShareReversed: payment.centerShareSnapshot,
      teacherShareReversed: payment.teacherShareSnapshot,
      reason: reason.trim(),
      refundedBy,
    },
  });
  const updatedPayment = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });

  const adjustedSettlements = await adjustUnpaidSettlementsForReversal(
    tx,
    centerId,
    payment,
    refund.teacherShareReversed,
  );

  return { ok: true, refund, payment: updatedPayment, adjustedSettlements };
}
