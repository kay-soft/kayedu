import type { Prisma, PrismaClient, Settlement, SettlementStatus } from "@prisma/client";
// Relative imports on purpose — `npm run check:settlements` and
// `npm run check:session-lifecycle` exercise this module directly.
import { MAX_STORED_PIASTRES } from "../money.ts";
import { addDays, dateKey, todayInTimezone } from "../scheduling.ts";
// The longest period one settlement may cover — a year and a day (D-16).
import { MAX_SETTLEMENT_PERIOD_DAYS } from "../validation/settlements.ts";
import {
  centerTimeZone,
  sessionsDueForAutoClose,
  ensureSessionOpenOrAutoClose,
} from "./session-lifecycle.ts";

/**
 * Teacher settlements — the payout register (M14, spec §5 "Teacher
 * settlements", docs/01-data-model.md "Finance-adjacent layer"). This is the
 * ONLY place a `Settlement` or `SettlementClaim` row is created or
 * transitioned — a pure reader/deriver of the existing frozen ledger, never a
 * writer of `Payment`'s money fields (CLAUDE.md rule 2).
 *
 * **Claims (SEC-2b, D-05 (c) — closes OD-8 and SEC-06).** A settlement does
 * not "cover a range" any more; it **claims payments**. Creating one writes a
 * `SettlementClaim` per payment it counts, in the same transaction, and its
 * total is the sum of those claims' frozen teacher shares. A payment belongs to
 * at most one live claim — the database refuses a second
 * (`SettlementClaim_one_live_per_payment`, a partial unique index) — so the
 * same teacher share can never be paid out twice, whichever shapes (session,
 * period) or overlaps are involved. Overlapping periods are therefore allowed
 * when they pick up money no live settlement holds yet (a session still live
 * when the first period was settled, OD-8); a settlement that would claim
 * nothing new over a range or session another live settlement already covers
 * is refused as before (`overlappingSettlement` / `sessionAlreadySettled`).
 *
 * Every creation first takes a transaction-scoped advisory lock per (centre,
 * teacher), so two concurrent creates for one teacher serialize and the second
 * reads the first's claims with a fresh statement. Transitions are
 * conditional updates on the expected status, so a double click changes
 * nothing twice.
 *
 * Takes a `Prisma.TransactionClient` exactly like `lib/db/payments.ts`'s
 * `recordPayment`/`voidPayment` and `lib/db/refunds.ts`'s `refundPayment` —
 * the caller wraps every write here in `prisma.$transaction()` and writes its
 * audit row on the same client (SEC-60).
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** DRAFT/APPROVED — a settlement whose payout has not left the centre yet. */
const UNPAID_SETTLEMENT_STATUSES: SettlementStatus[] = ["DRAFT", "APPROVED"];
const CANCELLED: SettlementStatus = "CANCELLED";


/** Enough for a year of one teacher's sessions; the close sweep's own cap. */
const PERIOD_CLOSE_SWEEP_LIMIT = 5_000;

export type AdjustedSettlement = { settlement: Settlement; previousTotal: number };

/**
 * Serializes settlement creation for one (centre, teacher): a
 * transaction-scoped advisory lock, released at commit/rollback. Must run
 * inside the caller's transaction.
 */
async function lockTeacherSettlements(tx: Db, centerId: string, teacherId: string): Promise<void> {
  const key = `settlement:${centerId}:${teacherId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * A payment's teacher share is leaving the ledger after the fact — refunded
 * (M14) or voided (R2) — so every DRAFT/APPROVED settlement whose stored total
 * **had counted it** is reduced by `teacherShareReversed`, in the caller's
 * transaction. The one implementation of that rule, shared by
 * `lib/db/refunds.ts`'s `refundPayment` and `lib/db/payments.ts`'s void path.
 * A PAID settlement is never touched (the money already left the centre —
 * spec §5 "Settlement totals").
 *
 * "Had counted it" is the payment's **live claim** (SEC-2b): the claim is
 * released in the same step, so a settlement's total always equals the sum of
 * its live claims. In practice this never fires for a claim-based settlement —
 * it claims only closed sessions, and a closed session refuses both void and
 * refund. It stays for a settlement with **no claims at all** (created before
 * claims existed and not backfilled, or written by hand), judged by the
 * pre-SEC-2b scope rule: the payment existed when the settlement was created,
 * and — for an R2 settlement (`closedSessionsOnly`) — its session was already
 * closed then.
 */
export async function adjustUnpaidSettlementsForReversal(
  tx: Db,
  centerId: string,
  payment: {
    id: string;
    teacherId: string;
    sessionId: string;
    recordedAt: Date;
    session: { date: Date; closedAt: Date | null };
  },
  teacherShareReversed: number,
): Promise<AdjustedSettlement[]> {
  const [claimed, unclaimedLegacy] = await Promise.all([
    tx.settlement.findMany({
      where: {
        centerId,
        status: { in: UNPAID_SETTLEMENT_STATUSES },
        claims: { some: { paymentId: payment.id, releasedAt: null } },
      },
    }),
    tx.settlement.findMany({
      where: {
        centerId,
        teacherId: payment.teacherId,
        status: { in: UNPAID_SETTLEMENT_STATUSES },
        createdAt: { gte: payment.recordedAt },
        claims: { none: {} },
        OR: [
          { sessionId: payment.sessionId },
          { periodFrom: { lte: payment.session.date }, periodTo: { gte: payment.session.date } },
        ],
      },
    }),
  ]);
  const legacy = unclaimedLegacy.filter((settlement) => {
    if (!settlement.closedSessionsOnly) return true;
    const closedAt = payment.session.closedAt;
    return closedAt !== null && closedAt <= settlement.createdAt;
  });

  const adjusted: AdjustedSettlement[] = [];
  for (const settlement of [...claimed, ...legacy]) {
    const previousTotal = settlement.totalAmount;
    // The floor at 0 is a defensive safety net, never expected to bind:
    // the payment contributed exactly this share to the total at creation.
    const updated = await tx.settlement.update({
      where: { id: settlement.id },
      data: { totalAmount: Math.max(0, previousTotal - teacherShareReversed) },
    });
    adjusted.push({ settlement: updated, previousTotal });
  }
  if (claimed.length > 0) {
    await tx.settlementClaim.updateMany({
      where: { centerId, paymentId: payment.id, releasedAt: null, settlementId: { in: claimed.map((s) => s.id) } },
      data: { releasedAt: new Date() },
    });
  }
  return adjusted;
}

/**
 * The payments a new settlement may claim (CLAUDE.md rule 7 "Settlements
 * derive, never recompute"): this teacher's non-voided AND non-refunded
 * payments in scope that **no live settlement has claimed** — read by a fresh
 * statement after the teacher's lock is held. Excluding already-refunded
 * payments keeps "a refunded payment cannot be included in a settlement's
 * total" true at creation (spec §5 "Teacher settlements").
 */
async function claimablePayments(
  tx: Db,
  centerId: string,
  teacherId: string,
  scopeWhere: Prisma.PaymentWhereInput,
): Promise<{ id: string; teacherShareSnapshot: number }[]> {
  return tx.payment.findMany({
    where: {
      centerId,
      teacherId,
      voided: false,
      refunded: false,
      settlementClaims: { none: { releasedAt: null } },
      ...scopeWhere,
    },
    select: { id: true, teacherShareSnapshot: true },
    orderBy: { recordedAt: "asc" },
  });
}

/** Writes the settlement and its claims; refuses a total beyond `integer`. */
async function writeSettlementWithClaims(
  tx: Db,
  centerId: string,
  data: Omit<Prisma.SettlementUncheckedCreateInput, "centerId" | "totalAmount">,
  claimable: { id: string; teacherShareSnapshot: number }[],
): Promise<CreateSettlementResult> {
  // Each share is ≤ the integer ceiling and there are at most thousands, so
  // this plain sum is exact (D-17); the stored total must still fit `integer`.
  const totalAmount = claimable.reduce((sum, payment) => sum + payment.teacherShareSnapshot, 0);
  if (totalAmount > MAX_STORED_PIASTRES) return { ok: false, error: "totalTooLarge" };
  const settlement = await tx.settlement.create({ data: { ...data, centerId, totalAmount } });
  if (claimable.length > 0) {
    await tx.settlementClaim.createMany({
      data: claimable.map((payment) => ({
        centerId,
        settlementId: settlement.id,
        paymentId: payment.id,
        teacherShare: payment.teacherShareSnapshot,
      })),
    });
  }
  return { ok: true, settlement, claimedPayments: claimable.length };
}

export type CreateSettlementResult =
  | { ok: true; settlement: Settlement; claimedPayments: number }
  | {
      ok: false;
      error:
        | "sessionNotFound"
        | "sessionNotClosed"
        | "sessionAlreadySettled"
        | "invalidRange"
        | "futureRange"
        | "rangeTooLong"
        | "overlappingSettlement"
        | "totalTooLarge";
    };

/**
 * The "pay cash right after this session" shape (spec §5 "Teacher
 * settlements"): the teacher is derived from the session itself — a session
 * has exactly one teacher. It claims every unclaimed payment of the session;
 * refused (`sessionAlreadySettled`) when a live settlement of this session
 * already exists, or when every payment of it is already claimed elsewhere.
 *
 * R2: **refused unless the session is closed** (`sessionNotClosed`) — a live
 * session's payments can still be voided or refunded, so settling it would
 * freeze a number that may yet change. A session whose day has ended is
 * closed (AUTO) right here first, then settled. Since SEC-2b a CANCELLED or
 * rescheduled session closes at the end of its day too, and is settled like
 * any closed session (normally for 0 — it cannot hold active money).
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

  const session = await tx.session.findFirst({
    where: { centerId, id: sessionId },
    select: { id: true, teacherId: true },
  });
  if (!session) return { ok: false, error: "sessionNotFound" };

  await lockTeacherSettlements(tx, centerId, session.teacherId);

  const existing = await tx.settlement.findFirst({
    where: { centerId, sessionId, status: { not: CANCELLED } },
    select: { id: true },
  });
  if (existing) return { ok: false, error: "sessionAlreadySettled" };

  const claimable = await claimablePayments(tx, centerId, session.teacherId, { sessionId });
  if (claimable.length === 0) {
    const claimedElsewhere = await tx.settlementClaim.count({
      where: { centerId, releasedAt: null, payment: { centerId, sessionId } },
    });
    if (claimedElsewhere > 0) return { ok: false, error: "sessionAlreadySettled" };
  }

  return writeSettlementWithClaims(
    tx,
    centerId,
    { teacherId: session.teacherId, sessionId, createdBy },
    claimable,
  );
}

/**
 * The D-16 bounds of a period (`from`/`to` inclusive UTC-midnight day
 * markers, `today` the centre's today): `from` on or before `to`, `to` not in
 * the future, at most `MAX_SETTLEMENT_PERIOD_DAYS` days. The zod schema checks
 * the first and last; this re-checks all three by direct call.
 */
export function settlementRangeError(
  from: Date,
  to: Date,
  today: Date,
): "invalidRange" | "futureRange" | "rangeTooLong" | null {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return "invalidRange";
  if (dateKey(to) > dateKey(today)) return "futureRange";
  if (addDays(from, MAX_SETTLEMENT_PERIOD_DAYS) <= to) return "rangeTooLong";
  return null;
}

/**
 * The period roll-up shape (spec §5 "Teacher settlements"): `from`/`to` are
 * inclusive UTC-midnight bounds on `Session.date`, mirroring
 * `lib/db/analytics.ts`'s `DateRange`, bounded by `settlementRangeError`.
 *
 * R2: **claims only payments of CLOSED sessions** in the range. Every session
 * in range whose day has already ended is closed (AUTO) first, in this
 * transaction, so "closed" means the same thing here as everywhere else; a
 * session still live today is left out (its money can still be voided or
 * refunded). The `/settlements` form says so. A later period overlapping this
 * one picks up exactly what this one left out (OD-8, resolved by D-05): it
 * claims only payments no live settlement holds; one that would claim nothing
 * over an already-settled range is refused (`overlappingSettlement`).
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
  const now = options.now ?? new Date();
  const timeZone = await centerTimeZone(tx, centerId);
  const rangeError = settlementRangeError(from, to, todayInTimezone(timeZone, now));
  if (rangeError) return { ok: false, error: rangeError };

  await lockTeacherSettlements(tx, centerId, teacherId);

  // Lazily close every session in range whose day has ended (R2) — terminal
  // ones included (D-07) — so the claim below sees them as the closed records
  // they already are.
  const ended = await sessionsDueForAutoClose(tx, centerId, now, { from, to, teacherId }, PERIOD_CLOSE_SWEEP_LIMIT);
  for (const id of ended) {
    await ensureSessionOpenOrAutoClose(tx, id, centerId, now, { allowTerminal: true });
  }

  const claimable = await claimablePayments(tx, centerId, teacherId, {
    session: { date: { gte: from, lte: to }, closedAt: { not: null } },
  });
  if (claimable.length === 0) {
    const overlapping = await tx.settlement.findFirst({
      where: {
        centerId,
        teacherId,
        status: { not: CANCELLED },
        periodFrom: { not: null, lte: to },
        periodTo: { not: null, gte: from },
      },
      select: { id: true },
    });
    if (overlapping) return { ok: false, error: "overlappingSettlement" };
  }

  return writeSettlementWithClaims(
    tx,
    centerId,
    { teacherId, periodFrom: from, periodTo: to, createdBy },
    claimable,
  );
}

/** Who is moving a settlement, and whether they are this centre's OWNER (D-12). */
export type SettlementActor = { userId: string; isOwner: boolean };

export type TransitionSettlementResult =
  | {
      ok: true;
      settlement: Settlement;
      /** The actor also created it — only an OWNER may (D-12); audited as such. */
      selfApproved: boolean;
    }
  | { ok: false; error: "notFound" | "notDraft" | "notApproved" | "ownSettlement" };

/**
 * DRAFT → APPROVED. Refuses to re-approve or to approve out of order, and —
 * separation of duties (SEC-2b, D-12, SEC-18) — refuses a non-OWNER approving
 * a settlement they created (`ownSettlement`). The OWNER may, and the result
 * says so (`selfApproved`) for the audit row. Conditional on the status, so a
 * concurrent second approve changes nothing.
 */
export async function approveSettlement(
  tx: Db,
  centerId: string,
  id: string,
  actor: SettlementActor,
): Promise<TransitionSettlementResult> {
  const settlement = await tx.settlement.findFirst({ where: { centerId, id } });
  if (!settlement) return { ok: false, error: "notFound" };
  if (settlement.status !== "DRAFT") return { ok: false, error: "notDraft" };
  const selfApproved = settlement.createdBy === actor.userId;
  if (selfApproved && !actor.isOwner) return { ok: false, error: "ownSettlement" };

  const changed = await tx.settlement.updateMany({
    where: { id, centerId, status: "DRAFT" },
    data: { status: "APPROVED", approvedBy: actor.userId, approvedAt: new Date() },
  });
  if (changed.count !== 1) return { ok: false, error: "notDraft" };
  const updated = await tx.settlement.findUniqueOrThrow({ where: { id } });
  return { ok: true, settlement: updated, selfApproved };
}

/**
 * APPROVED → PAID. No partially-paid state exists in this model (spec §5) —
 * a settlement is either fully paid or it stays exactly as it was. The same
 * D-12 rule as approval: a non-OWNER cannot pay a settlement they created.
 * Conditional on APPROVED, so a double "Mark paid" pays once.
 */
export async function paySettlement(
  tx: Db,
  centerId: string,
  id: string,
  actor: SettlementActor,
): Promise<TransitionSettlementResult> {
  const settlement = await tx.settlement.findFirst({ where: { centerId, id } });
  if (!settlement) return { ok: false, error: "notFound" };
  if (settlement.status !== "APPROVED") return { ok: false, error: "notApproved" };
  const selfApproved = settlement.createdBy === actor.userId;
  if (selfApproved && !actor.isOwner) return { ok: false, error: "ownSettlement" };

  const changed = await tx.settlement.updateMany({
    where: { id, centerId, status: "APPROVED" },
    data: { status: "PAID", paidBy: actor.userId, paidAt: new Date() },
  });
  if (changed.count !== 1) return { ok: false, error: "notApproved" };
  const updated = await tx.settlement.findUniqueOrThrow({ where: { id } });
  return { ok: true, settlement: updated, selfApproved };
}

export type CancelSettlementResult =
  | { ok: true; settlement: Settlement; releasedClaims: number }
  | { ok: false; error: "notFound" | "notDraft" };

/**
 * DRAFT → CANCELLED (SEC-2b, D-16 (c)): a wrong draft — the wrong teacher, a
 * mistyped range — is undone instead of blocking that teacher's payouts for
 * good. Its claims are **released** (`releasedAt`, never deleted), so the
 * payments can be claimed by a corrected settlement. APPROVED and PAID are
 * never cancelled. Conditional on DRAFT.
 */
export async function cancelSettlement(
  tx: Db,
  centerId: string,
  id: string,
  actor: { userId: string },
): Promise<CancelSettlementResult> {
  const settlement = await tx.settlement.findFirst({ where: { centerId, id } });
  if (!settlement) return { ok: false, error: "notFound" };
  if (settlement.status !== "DRAFT") return { ok: false, error: "notDraft" };

  const now = new Date();
  const changed = await tx.settlement.updateMany({
    where: { id, centerId, status: "DRAFT" },
    data: { status: CANCELLED, cancelledBy: actor.userId, cancelledAt: now },
  });
  if (changed.count !== 1) return { ok: false, error: "notDraft" };
  const released = await tx.settlementClaim.updateMany({
    where: { centerId, settlementId: id, releasedAt: null },
    data: { releasedAt: now },
  });
  const updated = await tx.settlement.findUniqueOrThrow({ where: { id } });
  return { ok: true, settlement: updated, releasedClaims: released.count };
}
