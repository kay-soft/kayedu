import type { Payment, Prisma, PrismaClient, Refund } from "@prisma/client";

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
  | { ok: true; refund: Refund; payment: Payment }
  | { ok: false; error: "notFound" | "alreadyVoided" | "alreadyRefunded" };

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
 */
export async function refundPayment(
  tx: Db,
  centerId: string,
  paymentId: string,
  reason: string,
  refundedBy: string,
): Promise<RefundPaymentResult> {
  const payment = await tx.payment.findFirst({
    where: { centerId, id: paymentId },
  });
  if (!payment) return { ok: false, error: "notFound" };
  if (payment.voided) return { ok: false, error: "alreadyVoided" };
  if (payment.refunded) return { ok: false, error: "alreadyRefunded" };

  const [refund, updatedPayment] = await Promise.all([
    tx.refund.create({
      data: {
        centerId,
        paymentId: payment.id,
        teacherId: payment.teacherId,
        amount: payment.amount,
        centerShareReversed: payment.centerShareSnapshot,
        teacherShareReversed: payment.teacherShareSnapshot,
        reason,
        refundedBy,
      },
    }),
    tx.payment.update({
      where: { id: payment.id },
      data: { refunded: true },
    }),
  ]);

  return { ok: true, refund, payment: updatedPayment };
}
