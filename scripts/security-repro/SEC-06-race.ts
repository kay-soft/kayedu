/**
 * A10-2 — settlement double-claim: the same payments' teacher share is
 * claimed by two settlements (= paid out twice).
 *
 * IMPORTED, not replicated: `createPeriodSettlement` / `createSessionSettlement`
 * / `approveSettlement` / `paySettlement` from lib/db/settlements.ts, wrapped
 * the way app/[locale]/(center)/settlements/actions.ts:57-60, 96-99, 131-134,
 * 162-165 wrap them (`prisma.$transaction(tx => ..., WRITE_TRANSACTION_OPTIONS)`,
 * READ COMMITTED). Fixture money goes through the real `recordPayment` and the
 * session is closed through the real `closeSession` (MANUAL "End session").
 *
 * Races shown (two PrismaClients = two server instances / two managers):
 *  (1) two concurrent period settlements, same teacher, same range — the
 *      overlap guard is a plain findFirst (settlements.ts:211-219) then create;
 *      no lock, no exclusion constraint.
 *  (2) two concurrent session settlements for the same closed session — the
 *      "already settled" guard is a plain findFirst (settlements.ts:170-171);
 *      the session lock taken by ensureSessionOpenOrAutoClose is FOR SHARE
 *      for an already-closed session, so the two do not serialize.
 *  (3) NO race needed (docs/00 §2.2 OD-8, already recorded as Open): a session
 *      settlement and a period settlement over the same session both count it.
 *  (4) double approve / double pay both "succeed" (status read then blind
 *      update by id) — two settlement.pay audit rows for one payout.
 *
 * Run: node --env-file-if-exists=.env scripts/security-repro/SEC-06-race.ts
 * Fixtures: centres `secrepro-a10-2*`, users `secrepro-a10-2*-*@kayedu.test`.
 */
import { PrismaClient } from "@prisma/client";
import { createAttendance } from "../../lib/db/attendance.ts";
import { recordPayment } from "../../lib/db/payments.ts";
import { closeSession, WRITE_TRANSACTION_OPTIONS } from "../../lib/db/session-lifecycle.ts";
import {
  approveSettlement,
  createPeriodSettlement,
  createSessionSettlement,
  paySettlement,
} from "../../lib/db/settlements.ts";
import { DEFAULT_TIMEZONE, todayInTimezone } from "../../lib/scheduling.ts";
import { cleanupA10, makeCenter, makeOpenSessionToday, makeStudent } from "./_fixtures.ts";

const prisma = new PrismaClient();
const mgrA = new PrismaClient();
const mgrB = new PrismaClient();
const TX = { ...WRITE_TRANSACTION_OPTIONS, timeout: 30_000 };

async function paidClosedSession(tag: string, students: number) {
  const { center, method, teacher } = await makeCenter(prisma, tag);
  const session = await makeOpenSessionToday(prisma, center.id, teacher.id);
  for (let i = 0; i < students; i++) {
    const s = await makeStudent(prisma, center.id, tag, i);
    const att = await createAttendance(prisma, {
      centerId: center.id, sessionId: session.id, studentProfileId: s.profile.id,
      enrollmentId: null, isDropIn: true, recordedBy: teacher.id,
    });
    const r = await prisma.$transaction((tx) => recordPayment(tx, center.id, att.id, method.id, teacher.id), TX);
    if (!r.ok) throw new Error(`fixture payment failed: ${r.error}`);
  }
  const closed = await closeSession(prisma, center.id, session.id, { closedBy: teacher.id });
  if (!closed.ok) throw new Error(`fixture close failed: ${closed.error}`);
  const teacherShare = (await prisma.payment.aggregate({
    where: { sessionId: session.id, voided: false }, _sum: { teacherShareSnapshot: true },
  }))._sum.teacherShareSnapshot ?? 0;
  return { center, teacher, session, teacherShare };
}

async function main() {
  await cleanupA10(prisma);
  const today = todayInTimezone(DEFAULT_TIMEZONE, new Date());
  let broken = 0;

  // (1) concurrent period settlements
  {
    const f = await paidClosedSession("2a", 3);
    const run = (c: PrismaClient) => c.$transaction(
      (tx) => createPeriodSettlement(tx, f.center.id, f.teacher.id, today, today, f.teacher.id), TX);
    const [a, b] = await Promise.all([run(mgrA), run(mgrB)]);
    const rows = await prisma.settlement.findMany({ where: { centerId: f.center.id } });
    const claimed = rows.reduce((n, r) => n + r.totalAmount, 0);
    console.log(`(1) period x2: A=${a.ok ? "ok" : a.error} B=${b.ok ? "ok" : b.error} settlements=${rows.length} claimed=${claimed} ledgerTeacherShare=${f.teacherShare}`);
    if (claimed > f.teacherShare) broken++;
  }
  // (2) concurrent session settlements
  {
    const f = await paidClosedSession("2b", 3);
    const run = (c: PrismaClient) => c.$transaction(
      (tx) => createSessionSettlement(tx, f.center.id, f.session.id, f.teacher.id), TX);
    const [a, b] = await Promise.all([run(mgrA), run(mgrB)]);
    const rows = await prisma.settlement.findMany({ where: { centerId: f.center.id } });
    const claimed = rows.reduce((n, r) => n + r.totalAmount, 0);
    console.log(`(2) session x2: A=${a.ok ? "ok" : a.error} B=${b.ok ? "ok" : b.error} settlements=${rows.length} claimed=${claimed} ledgerTeacherShare=${f.teacherShare}`);
    if (claimed > f.teacherShare) broken++;

    // (4) double approve / double pay on one of them
    const target = rows[0];
    const ap = await Promise.all([mgrA, mgrB].map((c) => c.$transaction((tx) => approveSettlement(tx, f.center.id, target.id, f.teacher.id), TX)));
    const pay = await Promise.all([mgrA, mgrB].map((c) => c.$transaction((tx) => paySettlement(tx, f.center.id, target.id, f.teacher.id), TX)));
    console.log(`(4) approve x2 ok=${ap.filter((r) => r.ok).length}/2, pay x2 ok=${pay.filter((r) => r.ok).length}/2 (each ok => the action writes a settlement.approve/.pay audit row)`);
  }
  // (3) sequential session + period (OD-8)
  {
    const f = await paidClosedSession("2c", 2);
    const s = await prisma.$transaction((tx) => createSessionSettlement(tx, f.center.id, f.session.id, f.teacher.id), TX);
    const p = await prisma.$transaction((tx) => createPeriodSettlement(tx, f.center.id, f.teacher.id, today, today, f.teacher.id), TX);
    const rows = await prisma.settlement.findMany({ where: { centerId: f.center.id } });
    const claimed = rows.reduce((n, r) => n + r.totalAmount, 0);
    console.log(`(3) session then period (no race, OD-8): session=${s.ok ? "ok" : s.error} period=${p.ok ? "ok" : p.error} claimed=${claimed} ledgerTeacherShare=${f.teacherShare}`);
    if (claimed > f.teacherShare) broken++;
  }
  console.log(broken > 0 ? "REPRODUCED" : "NOT REPRODUCED");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanupA10(prisma); } finally {
      await Promise.all([prisma.$disconnect(), mgrA.$disconnect(), mgrB.$disconnect()]);
    }
  });
