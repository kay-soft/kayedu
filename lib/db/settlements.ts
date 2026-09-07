import type { Prisma, PrismaClient, Settlement } from "@prisma/client";

/**
 * Teacher settlements — the payout register (M14, spec §5 "Teacher
 * settlements", docs/01-data-model.md "Finance-adjacent layer"). This is the
 * ONLY place a `Settlement` row is created or transitioned — a pure
 * reader/deriver of the existing frozen ledger, never a writer of
 * `Payment`'s money fields (CLAUDE.md rule 2).
 *
 * Takes a `Prisma.TransactionClient` exactly like `lib/db/payments.ts`'s
 * `recordPayment`/`voidPayment` and `lib/db/refunds.ts`'s `refundPayment` —
 * the caller wraps every write here in `prisma.$transaction()`.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The frozen-snapshot sum a settlement's total derives from (CLAUDE.md rule 7
 * "Settlements derive, never recompute"): non-voided AND non-refunded
 * `Payment.teacherShareSnapshot` rows in the given scope. Excluding
 * already-refunded payments here is what keeps "a refunded payment cannot
 * also be included in a settlement's total" true at creation time
 * (00-master-product-spec.md §5 "Teacher settlements"). Once a settlement
 * exists, this sum is never re-run against it — the stored `totalAmount` is
 * final from the moment of creation, including against a payment inside its
 * scope that is refunded afterward (see the schema comment on `Settlement`).
 */
async function sumTeacherShare(
  db: Db,
  centerId: string,
  teacherId: string,
  scopeWhere: Prisma.PaymentWhereInput,
): Promise<number> {
  const agg = await db.payment.aggregate({
    where: { centerId, teacherId, voided: false, refunded: false, ...scopeWhere },
    _sum: { teacherShareSnapshot: true },
  });
  return agg._sum.teacherShareSnapshot ?? 0;
}

export type CreateSettlementResult =
  | { ok: true; settlement: Settlement }
  | { ok: false; error: "sessionNotFound" | "sessionAlreadySettled" | "invalidRange" | "overlappingSettlement" };

/**
 * The "pay cash right after this session" shape (spec §5 "Teacher
 * settlements"): the teacher is derived from the session itself — a session
 * has exactly one teacher — and refused outright if any settlement (any
 * status; a settlement is never deleted or superseded) already claims this
 * session, so the same session's teacher share can never be paid out twice.
 */
export async function createSessionSettlement(
  tx: Db,
  centerId: string,
  sessionId: string,
  createdBy: string,
): Promise<CreateSettlementResult> {
  const session = await tx.session.findFirst({ where: { centerId, id: sessionId } });
  if (!session) return { ok: false, error: "sessionNotFound" };

  const existing = await tx.settlement.findFirst({ where: { centerId, sessionId } });
  if (existing) return { ok: false, error: "sessionAlreadySettled" };

  const totalAmount = await sumTeacherShare(tx, centerId, session.teacherId, { sessionId });

  const settlement = await tx.settlement.create({
    data: { centerId, teacherId: session.teacherId, sessionId, totalAmount, createdBy },
  });
  return { ok: true, settlement };
}

/**
 * The period roll-up shape (spec §5 "Teacher settlements"): `from`/`to` are
 * inclusive UTC-midnight bounds on `Session.date`, mirroring
 * `lib/db/analytics.ts`'s `DateRange`. Refused when it overlaps another
 * settlement already covering part of the same teacher's period — without
 * this, the same payment's teacher share could be claimed by two roll-ups
 * and paid out twice.
 */
export async function createPeriodSettlement(
  tx: Db,
  centerId: string,
  teacherId: string,
  from: Date,
  to: Date,
  createdBy: string,
): Promise<CreateSettlementResult> {
  if (from > to) return { ok: false, error: "invalidRange" };

  const overlapping = await tx.settlement.findFirst({
    where: {
      centerId,
      teacherId,
      periodFrom: { not: null, lte: to },
      periodTo: { not: null, gte: from },
    },
  });
  if (overlapping) return { ok: false, error: "overlappingSettlement" };

  const totalAmount = await sumTeacherShare(tx, centerId, teacherId, {
    session: { date: { gte: from, lte: to } },
  });

  const settlement = await tx.settlement.create({
    data: { centerId, teacherId, periodFrom: from, periodTo: to, totalAmount, createdBy },
  });
  return { ok: true, settlement };
}

export type TransitionSettlementResult =
  | { ok: true; settlement: Settlement }
  | { ok: false; error: "notFound" | "notDraft" | "notApproved" };

/** DRAFT → APPROVED. Refuses to re-approve or to approve out of order. */
export async function approveSettlement(
  tx: Db,
  centerId: string,
  id: string,
  approvedBy: string,
): Promise<TransitionSettlementResult> {
  const settlement = await tx.settlement.findFirst({ where: { centerId, id } });
  if (!settlement) return { ok: false, error: "notFound" };
  if (settlement.status !== "DRAFT") return { ok: false, error: "notDraft" };

  const updated = await tx.settlement.update({
    where: { id },
    data: { status: "APPROVED", approvedBy, approvedAt: new Date() },
  });
  return { ok: true, settlement: updated };
}

/**
 * APPROVED → PAID. No partially-paid state exists in this model (spec §5) —
 * a settlement is either fully paid or it stays exactly as it was.
 */
export async function paySettlement(
  tx: Db,
  centerId: string,
  id: string,
  paidBy: string,
): Promise<TransitionSettlementResult> {
  const settlement = await tx.settlement.findFirst({ where: { centerId, id } });
  if (!settlement) return { ok: false, error: "notFound" };
  if (settlement.status !== "APPROVED") return { ok: false, error: "notApproved" };

  const updated = await tx.settlement.update({
    where: { id },
    data: { status: "PAID", paidBy, paidAt: new Date() },
  });
  return { ok: true, settlement: updated };
}
