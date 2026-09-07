import type { Payment, Prisma, PrismaClient, Refund, Settlement } from "@prisma/client";

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

/** DRAFT/APPROVED — a settlement whose payout has not left the centre yet. */
const UNPAID_SETTLEMENT_STATUSES = ["DRAFT", "APPROVED"] as const;

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
      adjustedSettlements: { settlement: Settlement; previousTotal: number }[];
    }
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
 * settlement.
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
    include: { session: { select: { date: true } } },
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

  const inScopeSettlements = await tx.settlement.findMany({
    where: {
      centerId,
      teacherId: payment.teacherId,
      status: { in: [...UNPAID_SETTLEMENT_STATUSES] },
      OR: [
        { sessionId: payment.sessionId },
        { periodFrom: { lte: payment.session.date }, periodTo: { gte: payment.session.date } },
      ],
    },
  });

  const adjustedSettlements: { settlement: Settlement; previousTotal: number }[] = [];
  for (const settlement of inScopeSettlements) {
    const previousTotal = settlement.totalAmount;
    // A payment inside a settlement's scope contributed exactly its own
    // teacherShareSnapshot to that total at creation time (it could not have
    // been refunded yet then) — the floor at 0 is a defensive safety net,
    // never expected to bind in normal operation.
    const updated = await tx.settlement.update({
      where: { id: settlement.id },
      data: { totalAmount: Math.max(0, previousTotal - refund.teacherShareReversed) },
    });
    adjustedSettlements.push({ settlement: updated, previousTotal });
  }

  return { ok: true, refund, payment: updatedPayment, adjustedSettlements };
}
