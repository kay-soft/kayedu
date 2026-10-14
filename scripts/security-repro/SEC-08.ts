/**
 * A11-3 — Cancelling a session that already carries payments makes its money permanently
 * mutable and permanently un-settleable (SEC-1 audit, area A11 fraud/anti-cheat).
 *
 * What it proves, with the REAL production functions (relative .ts imports, no @/ alias):
 *  1. `cancelSession` (lib/db/sessions.ts:114-136) accepts a live session that already has a
 *     PAID attendee — there is no "has payments" refusal.
 *  2. A CANCELLED session is terminal and never closes (lib/db/session-lifecycle.ts:121-131,
 *     349-351, closeEndedSessions excludes CANCELLED at :576), and void/refund run the guard with
 *     `allowTerminal: true` (lib/db/payments.ts:211-214, lib/db/refunds.ts:93-96) — so the
 *     payment can still be voided MONTHS later, with today's real clock, long after the day's
 *     cash was counted and long after the data-visibility window would hide the session.
 *  3. The cancelled session's payment is still counted as revenue/teacher share
 *     (`revenueTotals` filters only `voided:false`, lib/db/analytics.ts:91-100) but can never
 *     enter any settlement: `createSessionSettlement` refuses a non-closed session
 *     (lib/db/settlements.ts:146-149) and `createPeriodSettlement` sums only
 *     `closedAt: { not: null }` sessions (lib/db/settlements.ts:214-216).
 *
 * The session is dated 2026-03-10; attendance, payment and cancel are written with the
 * functions' own injectable `now` set to that afternoon (the gates use the same seam) — no
 * `historicalBackfill`. The void then runs with the real current clock.
 *
 * Fixtures: own throwaway centre (slug `secrepro-a11-3`), users `secrepro-a11-3-*@kayedu.test`;
 * pre-cleaned and deleted in finally. No Supabase Auth users.
 *
 * Run:  node --env-file-if-exists=.env scripts/security-repro/SEC-08.ts
 */
import { PrismaClient } from "@prisma/client";
import { scopedData } from "../../lib/db/tenant-scope.ts";
import { createAttendance } from "../../lib/db/attendance.ts";
import { recordPayment, voidPayment } from "../../lib/db/payments.ts";
import { ensureDefaultPaymentMethods, listActivePaymentMethods } from "../../lib/db/payment-methods.ts";
import { cancelSession } from "../../lib/db/sessions.ts";
import { createPeriodSettlement, createSessionSettlement } from "../../lib/db/settlements.ts";
import { revenueTotals } from "../../lib/db/analytics.ts";

const prisma = new PrismaClient();
const SLUG = "secrepro-a11-3";
const EMAIL_PREFIX = "secrepro-a11-3-";
const PRICE = 10_000;
const FIXED_CUT = 2_000;

async function cleanup() {
  const centers = await prisma.center.findMany({ where: { slug: SLUG }, select: { id: true, organizationId: true } });
  const ids = centers.map((c) => c.id);
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.settlement.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.refund.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.center.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: centers.map((c) => c.organizationId) } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function main() {
  await cleanup();
  const center = await prisma.center.create({
    data: { slug: SLUG, name: "secrepro A11-3", organization: { create: { name: "secrepro A11-3" } } },
  });
  const teacher = await prisma.user.create({ data: { firstName: "T", lastName: "A11", email: `${EMAIL_PREFIX}teacher@kayedu.test`, locale: "en" } });
  await prisma.membership.create({
    data: scopedData(center.id, { userId: teacher.id, role: "TEACHER", firstName: "T", lastName: "A11", email: teacher.email, joinedAt: new Date() }),
  });
  const manager = await prisma.user.create({ data: { firstName: "M", lastName: "A11", email: `${EMAIL_PREFIX}manager@kayedu.test`, locale: "en" } });
  const studentUser = await prisma.user.create({ data: { firstName: "S", lastName: "A11", email: `${EMAIL_PREFIX}student@kayedu.test`, locale: "en" } });
  const student = await prisma.studentProfile.create({
    data: scopedData(center.id, { userId: studentUser.id, studentCode: "A11S3", firstName: "S", lastName: "A11" }),
  });
  const cls = await prisma.classGroup.create({
    data: scopedData(center.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"),
      teacherId: teacher.id, price: PRICE, centerShareType: "FIXED", centerShareValue: FIXED_CUT,
    }),
  });
  await ensureDefaultPaymentMethods(prisma, center.id);
  const [method] = await listActivePaymentMethods(prisma, center.id);

  const day = new Date("2026-03-10T00:00:00Z");
  const duringSession = new Date("2026-03-10T14:05:00Z"); // 16:05 Cairo (UTC+2 in March)
  const session = await prisma.session.create({
    data: scopedData(center.id, { classGroupId: cls.id, teacherId: teacher.id, date: day, startTime: "16:00", endTime: "18:00", priceSnapshot: PRICE }),
  });
  const attendee = await createAttendance(
    prisma,
    { centerId: center.id, sessionId: session.id, studentProfileId: student.id, enrollmentId: null, isDropIn: true, recordedBy: manager.id },
    { now: duringSession },
  );
  const paid = await prisma.$transaction((tx) =>
    recordPayment(tx, center.id, attendee.id, method.id, manager.id, { now: duringSession }),
  );
  if (!paid.ok) throw new Error(`recordPayment failed: ${JSON.stringify(paid)}`);
  console.log(`live session ${day.toISOString().slice(0, 10)}: attendee ${attendee.attendanceStatus}, payment ${paid.payment.amount} (teacher share ${paid.payment.teacherShareSnapshot})`);

  const cancelled = await cancelSession(prisma, center.id, session.id, { now: new Date("2026-03-10T14:30:00Z") });
  console.log(`cancelSession on the PAID live session: ok=${cancelled.ok}`);

  const march = { from: new Date("2026-03-01T00:00:00Z"), to: new Date("2026-03-31T00:00:00Z") };
  const rev = await revenueTotals(prisma, center.id, march, teacher.id);
  const sessionSettle = await prisma.$transaction((tx) => createSessionSettlement(tx, center.id, session.id, manager.id));
  const periodSettle = await prisma.$transaction((tx) =>
    createPeriodSettlement(tx, center.id, teacher.id, march.from, march.to, manager.id),
  );
  console.log(`March revenue still counts it: collected=${rev.collected} teacherShare=${rev.teacherShare}`);
  console.log(`session settlement: ${sessionSettle.ok ? `ok total=${sessionSettle.settlement.totalAmount}` : sessionSettle.error}`);
  console.log(`period settlement for March: ${periodSettle.ok ? `ok total=${periodSettle.settlement.totalAmount}` : periodSettle.error}`);

  // Seven months later, real clock: the payment is still voidable.
  const lateVoid = await prisma.$transaction((tx) =>
    voidPayment(tx, center.id, paid.payment.id, "late correction", manager.id),
  );
  console.log(`voidPayment ${new Date().toISOString().slice(0, 10)} (real clock) on the ${day.toISOString().slice(0, 10)} payment: ok=${lateVoid.ok}${lateVoid.ok ? "" : ` ${lateVoid.error}`}`);
  const revAfter = await revenueTotals(prisma, center.id, march, teacher.id);
  console.log(`March revenue after the late void: collected=${revAfter.collected}`);

  const reproduced =
    cancelled.ok &&
    rev.teacherShare === paid.payment.teacherShareSnapshot &&
    !sessionSettle.ok &&
    periodSettle.ok && periodSettle.settlement.totalAmount === 0 &&
    lateVoid.ok && revAfter.collected === 0;
  console.log(reproduced ? "REPRODUCED" : "NOT REPRODUCED");
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
