/**
 * A10-3 — refund racing void puts one payment in BOTH states (voided AND
 * refunded), which every revenue reader then subtracts twice; plus double
 * void and double refund.
 *
 * IMPORTED, not replicated: `voidPayment` (lib/db/payments.ts) and
 * `refundPayment` (lib/db/refunds.ts), wrapped as
 * app/[locale]/(center)/sessions/actions.ts:552-555 and 597-600 wrap them
 * (`prisma.$transaction(..., WRITE_TRANSACTION_OPTIONS)`, READ COMMITTED).
 * Both take only a FOR SHARE lock on the session (compatible with each other)
 * and then read the Payment row with a plain findFirst (payments.ts:240-246,
 * refunds.ts:100-106) and check `voided`/`refunded` before a blind
 * `update where id` — no row lock on Payment, no `where voided=false AND
 * refunded=false` on the update, no CHECK (NOT (voided AND refunded)).
 * Revenue effect read with the same formula lib/db/analytics.ts:95-106 uses:
 *   sum(amount WHERE voided=false) - sum(Refund.amount).
 *
 * Run: node --env-file-if-exists=.env scripts/security-repro/SEC-12.ts
 * Fixtures: centre `secrepro-a10-3`, users `secrepro-a10-3-*@kayedu.test`.
 */
import { PrismaClient } from "@prisma/client";
import { createAttendance } from "../../lib/db/attendance.ts";
import { recordPayment, voidPayment } from "../../lib/db/payments.ts";
import { refundPayment } from "../../lib/db/refunds.ts";
import { WRITE_TRANSACTION_OPTIONS } from "../../lib/db/session-lifecycle.ts";
import { cleanupA10, makeCenter, makeOpenSessionToday, makeStudent } from "./_fixtures.ts";

const prisma = new PrismaClient();
const a = new PrismaClient();
const b = new PrismaClient();
const TX = WRITE_TRANSACTION_OPTIONS;
const settle = <T,>(p: Promise<T>) => p.then((v) => ({ v }), (e: Error) => ({ e: e.message.split("\n").slice(-1)[0] }));
const fmt = (r: { v?: { ok: boolean; error?: string } ; e?: string }) => (r.e ? `threw(${r.e.slice(0, 60)})` : r.v!.ok ? "ok" : r.v!.error);

async function main() {
  await cleanupA10(prisma);
  const { center, method, teacher } = await makeCenter(prisma, "3");
  const session = await makeOpenSessionToday(prisma, center.id, teacher.id);
  let i = 0;
  const paidAttendee = async () => {
    const s = await makeStudent(prisma, center.id, "3", i++);
    const att = await createAttendance(prisma, { centerId: center.id, sessionId: session.id, studentProfileId: s.profile.id, enrollmentId: null, isDropIn: true, recordedBy: teacher.id });
    const r = await prisma.$transaction((tx) => recordPayment(tx, center.id, att.id, method.id, teacher.id), TX);
    if (!r.ok) throw new Error(r.error);
    return r.payment;
  };
  let broken = 0;

  // (1) refund vs void, several rounds
  for (let round = 0; round < 4; round++) {
    const p = await paidAttendee();
    const [rf, vd] = await Promise.all([
      settle(a.$transaction((tx) => refundPayment(tx, center.id, p.id, "race", teacher.id), TX)),
      settle(b.$transaction((tx) => voidPayment(tx, center.id, p.id, "race", teacher.id), TX)),
    ]);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    const refunds = await prisma.refund.aggregate({ where: { paymentId: p.id }, _sum: { amount: true } });
    const revenue = (row.voided ? 0 : row.amount) - (refunds._sum.amount ?? 0);
    console.log(`(1.${round}) refund=${fmt(rf)} void=${fmt(vd)} -> voided=${row.voided} refunded=${row.refunded} revenueContribution=${revenue} (amount=${row.amount}; correct is 0)`);
    if (row.voided && row.refunded) broken++;
  }

  // (2) double void
  {
    const p = await paidAttendee();
    const r = await Promise.all([a, b].map((c) => settle(c.$transaction((tx) => voidPayment(tx, center.id, p.id, "dbl", teacher.id), TX))));
    console.log(`(2) void x2: ${r.map(fmt).join(", ")} (two ok => two payment.void audit rows and adjustUnpaidSettlementsForReversal runs twice)`);
  }
  // (3) double refund — Refund_paymentId_key should block the second
  {
    const p = await paidAttendee();
    const r = await Promise.all([a, b].map((c) => settle(c.$transaction((tx) => refundPayment(tx, center.id, p.id, "dbl", teacher.id), TX))));
    const n = await prisma.refund.count({ where: { paymentId: p.id } });
    console.log(`(3) refund x2: ${r.map(fmt).join(", ")} refundRows=${n} (DB unique index => blocked)`);
  }
  console.log(broken > 0 ? "REPRODUCED" : "NOT REPRODUCED");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { try { await cleanupA10(prisma); } finally { await Promise.all([prisma.$disconnect(), a.$disconnect(), b.$disconnect()]); } });
