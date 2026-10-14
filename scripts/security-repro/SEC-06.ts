/**
 * A11-1 — A teacher's share can be settled TWICE: once by a session settlement and again by a
 * period settlement that covers the same session (SEC-1 audit, area A11 fraud/anti-cheat).
 *
 * What it proves: `createSessionSettlement` only refuses a session that already has a
 * settlement with the same `sessionId` (lib/db/settlements.ts:155-156), and
 * `createPeriodSettlement` only refuses an overlapping *period* settlement
 * (`periodFrom: { not: null }`, lib/db/settlements.ts:185-193). Neither looks at the other
 * shape, and `sumTeacherShare` (lib/db/settlements.ts:105-116) does not exclude payments of a
 * session that is already settled. So one session's teacher share lands in two settlements and
 * both can go DRAFT -> APPROVED -> PAID. Also run in the reverse order (period first, then
 * session) to show neither ordering is guarded.
 *
 * Everything here is the REAL production code, imported (relative .ts imports, no @/ alias):
 * createAttendance, recordPayment, createSessionSettlement, createPeriodSettlement,
 * approveSettlement, paySettlement. Payments are written with `historicalBackfill` (the scripts-
 * only escape hatch the existing gates use) because the session is past-dated; that flag only
 * skips the closed-session check on the WRITE, it plays no part in the settlement logic tested.
 *
 * Fixtures: own throwaway centre (slug `secrepro-a11-1`), users `secrepro-a11-*@kayedu.test`;
 * pre-cleaned and deleted in finally. No Supabase Auth users.
 *
 * Run:  node --env-file-if-exists=.env scripts/security-repro/SEC-06.ts
 */
import { PrismaClient } from "@prisma/client";
import { scopedData } from "../../lib/db/tenant-scope.ts";
import { createAttendance } from "../../lib/db/attendance.ts";
import { recordPayment } from "../../lib/db/payments.ts";
import { ensureDefaultPaymentMethods, listActivePaymentMethods } from "../../lib/db/payment-methods.ts";
import {
  approveSettlement,
  createPeriodSettlement,
  createSessionSettlement,
  paySettlement,
} from "../../lib/db/settlements.ts";

const prisma = new PrismaClient();
const SLUG = "secrepro-a11-1";
const EMAIL_PREFIX = "secrepro-a11-1-";
const PRICE = 10_000; // 100 EGP
const FIXED_CUT = 2_000; // centre takes 20 EGP -> teacher share 80 EGP = 8,000 piastres

async function cleanup() {
  const centers = await prisma.center.findMany({ where: { slug: SLUG }, select: { id: true, organizationId: true } });
  const ids = centers.map((c) => c.id);
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.settlement.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.refund.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.center.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: centers.map((c) => c.organizationId).filter(Boolean) as string[] } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function paidSession(centerId: string, classGroupId: string, teacherId: string, studentProfileId: string, date: Date, methodId: string, actorId: string) {
  const session = await prisma.session.create({
    data: scopedData(centerId, { classGroupId, teacherId, date, startTime: "16:00", endTime: "18:00", priceSnapshot: PRICE }),
  });
  const attendee = await createAttendance(
    prisma,
    { centerId, sessionId: session.id, studentProfileId, enrollmentId: null, isDropIn: true, recordedBy: actorId },
    { historicalBackfill: true, status: "PRESENT" },
  );
  const paid = await prisma.$transaction((tx) =>
    recordPayment(tx, centerId, attendee.id, methodId, actorId, { historicalBackfill: true }),
  );
  if (!paid.ok) throw new Error(`recordPayment failed: ${JSON.stringify(paid)}`);
  return { session, payment: paid.payment };
}

async function main() {
  await cleanup();
  const center = await prisma.center.create({
    data: { slug: SLUG, name: "secrepro A11-1", organization: { create: { name: "secrepro A11-1" } } },
  });
  const teacher = await prisma.user.create({ data: { firstName: "T", lastName: "A11", email: `${EMAIL_PREFIX}teacher@kayedu.test`, locale: "en" } });
  await prisma.membership.create({
    data: scopedData(center.id, { userId: teacher.id, role: "TEACHER", firstName: "T", lastName: "A11", email: teacher.email, joinedAt: new Date() }),
  });
  const manager = await prisma.user.create({ data: { firstName: "M", lastName: "A11", email: `${EMAIL_PREFIX}manager@kayedu.test`, locale: "en" } });
  const studentUser = await prisma.user.create({ data: { firstName: "S", lastName: "A11", email: `${EMAIL_PREFIX}student@kayedu.test`, locale: "en" } });
  const student = await prisma.studentProfile.create({
    data: scopedData(center.id, { userId: studentUser.id, studentCode: "A11S1", firstName: "S", lastName: "A11" }),
  });
  const cls = await prisma.classGroup.create({
    data: scopedData(center.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"),
      teacherId: teacher.id, price: PRICE, centerShareType: "FIXED", centerShareValue: FIXED_CUT,
    }),
  });
  await ensureDefaultPaymentMethods(prisma, center.id);
  const [method] = await listActivePaymentMethods(prisma, center.id);

  // ── Order 1: session settlement first, then a period covering that session ──
  const d1 = new Date("2026-06-03T00:00:00Z");
  const one = await paidSession(center.id, cls.id, teacher.id, student.id, d1, method.id, manager.id);
  console.log(`payment on ${d1.toISOString().slice(0, 10)}: amount=${one.payment.amount} teacherShare=${one.payment.teacherShareSnapshot}`);

  const sessionSettlement = await prisma.$transaction((tx) => createSessionSettlement(tx, center.id, one.session.id, manager.id));
  if (!sessionSettlement.ok) throw new Error(`session settlement refused: ${JSON.stringify(sessionSettlement)}`);
  const periodSettlement = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, center.id, teacher.id, new Date("2026-06-01T00:00:00Z"), new Date("2026-06-07T00:00:00Z"), manager.id),
  );
  console.log(`order1 session settlement: ok total=${sessionSettlement.settlement.totalAmount}`);
  console.log(`order1 period settlement over the same session: ok=${periodSettlement.ok} ${periodSettlement.ok ? `total=${periodSettlement.settlement.totalAmount}` : JSON.stringify(periodSettlement)}`);

  // Same person drives both through to PAID — no segregation of duties either.
  let paidTotal = 0;
  for (const s of [sessionSettlement.ok ? sessionSettlement.settlement : null, periodSettlement.ok ? periodSettlement.settlement : null]) {
    if (!s) continue;
    const a = await prisma.$transaction((tx) => approveSettlement(tx, center.id, s.id, manager.id));
    const p = await prisma.$transaction((tx) => paySettlement(tx, center.id, s.id, manager.id));
    if (a.ok && p.ok) paidTotal += p.settlement.totalAmount;
  }
  console.log(`order1 PAID out to teacher for ONE payment whose teacher share is ${one.payment.teacherShareSnapshot}: ${paidTotal}`);
  const order1 = periodSettlement.ok && paidTotal === 2 * one.payment.teacherShareSnapshot;

  // ── Order 2: period first, then a session settlement for a session inside it ──
  const d2 = new Date("2026-07-03T00:00:00Z");
  const two = await paidSession(center.id, cls.id, teacher.id, student.id, d2, method.id, manager.id);
  const period2 = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, center.id, teacher.id, new Date("2026-07-01T00:00:00Z"), new Date("2026-07-07T00:00:00Z"), manager.id),
  );
  const session2 = await prisma.$transaction((tx) => createSessionSettlement(tx, center.id, two.session.id, manager.id));
  const claimed2 = (period2.ok ? period2.settlement.totalAmount : 0) + (session2.ok ? session2.settlement.totalAmount : 0);
  console.log(`order2 period ok=${period2.ok} then session ok=${session2.ok}; claimed for one teacher share of ${two.payment.teacherShareSnapshot}: ${claimed2}`);
  const order2 = period2.ok && session2.ok && claimed2 === 2 * two.payment.teacherShareSnapshot;

  console.log(order1 || order2 ? "REPRODUCED" : "NOT REPRODUCED");
}

main()
  .catch((error) => {
    console.error(error);
    console.log("NOT REPRODUCED");
  })
  .finally(async () => {
    try {
      await cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });
