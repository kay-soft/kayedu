import type { Prisma, PrismaClient, Settlement, SessionStatus } from "@prisma/client";
// Relative imports on purpose — `npm run check:settlements` and
// `npm run check:session-lifecycle` exercise this module directly.
import { todayInTimezone } from "../scheduling.ts";
import { centerTimeZone, ensureSessionOpenOrAutoClose } from "./session-lifecycle.ts";

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

/** DRAFT/APPROVED — a settlement whose payout has not left the centre yet. */
const UNPAID_SETTLEMENT_STATUSES = ["DRAFT", "APPROVED"] as const;

export type AdjustedSettlement = { settlement: Settlement; previousTotal: number };

/**
 * A payment's teacher share is leaving the ledger after the fact — refunded
 * (M14) or voided (R2) — so every DRAFT/APPROVED settlement whose stored
 * total **had counted it** is reduced by `teacherShareReversed`, in the
 * caller's transaction. The one implementation of that rule, shared by
 * `lib/db/refunds.ts`'s `refundPayment` and `lib/db/payments.ts`'s void path.
 * A PAID settlement is never touched (the money already left the centre —
 * spec §5 "Settlement totals").
 *
 * "Had counted it" is decided from what the settlement's own creation rule
 * summed, not merely from its date scope:
 * - the payment existed when the settlement was created (recordedAt is not
 *   after createdAt) — a payment recorded afterwards was never in the total;
 * - for a settlement created since R2 (`closedSessionsOnly`), the payment's
 *   session was already closed at creation. A payment on a session still
 *   live at creation was excluded from the total, so reversing it must not
 *   reduce the total either. (A closed session refuses both void and
 *   refund, so a live reversal never matches an R2 settlement in practice;
 *   only a pre-R2 row, or a scripts-only `historicalBackfill` reversal, can.)
 */
export async function adjustUnpaidSettlementsForReversal(
  tx: Db,
  centerId: string,
  payment: {
    teacherId: string;
    sessionId: string;
    recordedAt: Date;
    session: { date: Date; closedAt: Date | null };
  },
  teacherShareReversed: number,
): Promise<AdjustedSettlement[]> {
  const inScope = await tx.settlement.findMany({
    where: {
      centerId,
      teacherId: payment.teacherId,
      status: { in: [...UNPAID_SETTLEMENT_STATUSES] },
      createdAt: { gte: payment.recordedAt },
      OR: [
        { sessionId: payment.sessionId },
        { periodFrom: { lte: payment.session.date }, periodTo: { gte: payment.session.date } },
      ],
    },
  });

  const adjusted: AdjustedSettlement[] = [];
  for (const settlement of inScope) {
    if (settlement.closedSessionsOnly) {
      const closedAt = payment.session.closedAt;
      if (!closedAt || closedAt > settlement.createdAt) continue;
    }
    const previousTotal = settlement.totalAmount;
    // The floor at 0 is a defensive safety net, never expected to bind:
    // the payment contributed exactly this share to the total at creation.
    const updated = await tx.settlement.update({
      where: { id: settlement.id },
      data: { totalAmount: Math.max(0, previousTotal - teacherShareReversed) },
    });
    adjusted.push({ settlement: updated, previousTotal });
  }
  return adjusted;
}

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
  | {
      ok: false;
      error:
        | "sessionNotFound"
        | "sessionNotClosed"
        | "sessionAlreadySettled"
        | "invalidRange"
        | "overlappingSettlement";
    };

/**
 * The "pay cash right after this session" shape (spec §5 "Teacher
 * settlements"): the teacher is derived from the session itself — a session
 * has exactly one teacher — and refused outright if any settlement (any
 * status; a settlement is never deleted or superseded) already claims this
 * session, so the same session's teacher share can never be paid out twice.
 *
 * R2: **refused unless the session is closed** (`sessionNotClosed`) — a live
 * session's payments can still be voided or refunded, so settling it would
 * freeze a number that may yet change. A session whose day has ended is
 * closed (AUTO) right here first, then settled. CANCELLED and rescheduled
 * sessions never close, so they are never settled this way.
 */
export async function createSessionSettlement(
  tx: Db,
  centerId: string,
  sessionId: string,
  createdBy: string,
  options: { now?: Date } = {},
): Promise<CreateSettlementResult> {
  const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, options.now, {
    allowTerminal: true,
  });
  if (gate.status === "missing") return { ok: false, error: "sessionNotFound" };
  if (gate.status === "open") return { ok: false, error: "sessionNotClosed" };

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
 *
 * R2: **counts only payments from CLOSED sessions** in the range. Every
 * session in range whose day has already ended is closed (AUTO) first, in
 * this transaction, so "closed" means the same thing here as everywhere
 * else; a session still live today is left out of the total entirely (its
 * money can still be voided or refunded). The `/settlements` form says so.
 */
export async function createPeriodSettlement(
  tx: Db,
  centerId: string,
  teacherId: string,
  from: Date,
  to: Date,
  createdBy: string,
  options: { now?: Date } = {},
): Promise<CreateSettlementResult> {
  if (from > to) return { ok: false, error: "invalidRange" };
  const now = options.now ?? new Date();

  const overlapping = await tx.settlement.findFirst({
    where: {
      centerId,
      teacherId,
      periodFrom: { not: null, lte: to },
      periodTo: { not: null, gte: from },
    },
  });
  if (overlapping) return { ok: false, error: "overlappingSettlement" };

  // Lazily close every session in range whose day has ended (R2), so the
  // sum below sees them as the closed records they already are.
  const timeZone = await centerTimeZone(tx, centerId);
  const todayStart = todayInTimezone(timeZone, now);
  const cancelled: SessionStatus = "CANCELLED";
  const endedOpen = await tx.session.findMany({
    where: {
      centerId,
      teacherId,
      closedAt: null,
      rescheduledToId: null,
      status: { not: cancelled },
      date: { gte: from, lte: to, lt: todayStart },
    },
    select: { id: true },
  });
  for (const ended of endedOpen) {
    await ensureSessionOpenOrAutoClose(tx, ended.id, centerId, now);
  }

  const totalAmount = await sumTeacherShare(tx, centerId, teacherId, {
    session: { date: { gte: from, lte: to }, closedAt: { not: null } },
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
