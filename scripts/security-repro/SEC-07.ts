/**
 * A11-2 — A voided payment and an unpaid PRESENT attendee leave no trace any centre user can
 * see (SEC-1 audit, area A11 fraud/anti-cheat).
 *
 * What it proves:
 *  Dynamic (REAL production code, relative .ts imports): on one live session, student 1 is
 *  checked in with no payment (the reception desk's "no method" path, receptionCheckInSchema
 *  `paymentMethodId: optionalRef`), student 2 is checked in, pays, and the payment is voided
 *  (`voidPayment`). `sessionReceiptTotals` (lib/db/payments.ts:278-310) then reports
 *  present=2, collected=0 — and its only "paid" signal, `paidCount`, is never rendered.
 *  Static (file scan of app/ + components/, read-only): the receipt component never reads
 *  `paidCount`; nothing under app/ reads `voided: true` payments, `voidReason`, or the centre
 *  audit trail (`scoped(ctx).auditLogs.list`, lib/db/scoped.ts:977) — the only AuditLog reader
 *  in app/ is the platform-admin page. So the OWNER has no screen on which a void (or an unpaid
 *  check-in) appears.
 *
 * Writes use the functions' injectable `now` (session dated 2026-06-10, clock set to that
 * afternoon) — no historicalBackfill.
 *
 * Fixtures: own throwaway centre (slug `secrepro-a11-2`), users `secrepro-a11-2-*@kayedu.test`;
 * pre-cleaned and deleted in finally. No Supabase Auth users.
 *
 * Run:  node --env-file-if-exists=.env scripts/security-repro/SEC-07.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { scopedData } from "../../lib/db/tenant-scope.ts";
import { createAttendance } from "../../lib/db/attendance.ts";
import { recordPayment, sessionReceiptTotals, voidPayment } from "../../lib/db/payments.ts";
import { ensureDefaultPaymentMethods, listActivePaymentMethods } from "../../lib/db/payment-methods.ts";

const prisma = new PrismaClient();
const SLUG = "secrepro-a11-2";
const EMAIL_PREFIX = "secrepro-a11-2-";
const PRICE = 10_000;

async function cleanup() {
  const centers = await prisma.center.findMany({ where: { slug: SLUG }, select: { id: true, organizationId: true } });
  const ids = centers.map((c) => c.id);
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { centerId: { in: ids } } });
    await prisma.center.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: centers.map((c) => c.organizationId) } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

async function main() {
  await cleanup();
  const center = await prisma.center.create({
    data: { slug: SLUG, name: "secrepro A11-2", organization: { create: { name: "secrepro A11-2" } } },
  });
  const teacher = await prisma.user.create({ data: { firstName: "T", lastName: "A11", email: `${EMAIL_PREFIX}teacher@kayedu.test`, locale: "en" } });
  await prisma.membership.create({
    data: scopedData(center.id, { userId: teacher.id, role: "TEACHER", firstName: "T", lastName: "A11", email: teacher.email, joinedAt: new Date() }),
  });
  const staff = await prisma.user.create({ data: { firstName: "M", lastName: "A11", email: `${EMAIL_PREFIX}staff@kayedu.test`, locale: "en" } });
  const students = [];
  for (const code of ["A11S21", "A11S22"]) {
    const u = await prisma.user.create({ data: { firstName: "S", lastName: code, email: `${EMAIL_PREFIX}${code.toLowerCase()}@kayedu.test`, locale: "en" } });
    students.push(await prisma.studentProfile.create({ data: scopedData(center.id, { userId: u.id, studentCode: code, firstName: "S", lastName: code }) }));
  }
  const cls = await prisma.classGroup.create({
    data: scopedData(center.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2026-12-31"),
      teacherId: teacher.id, price: PRICE, centerShareType: "PERCENTAGE", centerShareValue: 20,
    }),
  });
  await ensureDefaultPaymentMethods(prisma, center.id);
  const [method] = await listActivePaymentMethods(prisma, center.id);

  const now = new Date("2026-06-10T13:05:00Z"); // 16:05 Cairo (UTC+3 in June)
  const session = await prisma.session.create({
    data: scopedData(center.id, { classGroupId: cls.id, teacherId: teacher.id, date: new Date("2026-06-10T00:00:00Z"), startTime: "16:00", endTime: "18:00", priceSnapshot: PRICE }),
  });
  const base = { centerId: center.id, sessionId: session.id, enrollmentId: null, isDropIn: true, recordedBy: staff.id };
  await createAttendance(prisma, { ...base, studentProfileId: students[0].id }, { now }); // checked in, no payment
  const a2 = await createAttendance(prisma, { ...base, studentProfileId: students[1].id }, { now });
  const paid = await prisma.$transaction((tx) => recordPayment(tx, center.id, a2.id, method.id, staff.id, { now }));
  if (!paid.ok) throw new Error(JSON.stringify(paid));
  const voided = await prisma.$transaction((tx) => voidPayment(tx, center.id, paid.payment.id, "x", staff.id, { now }));
  console.log(`void ok=${voided.ok}`);

  const totals = await sessionReceiptTotals(prisma, center.id, session.id);
  console.log(`receipt totals: present=${totals.presentCount} late=${totals.lateCount} collected=${totals.collected} paidCount=${totals.paidCount}`);

  // Static scan
  const receiptSrc = readFileSync("app/[locale]/(center)/sessions/[id]/session-receipt.tsx", "utf8");
  const receiptShowsPaid = /paidCount/.test(receiptSrc);
  const files = [...walk("app"), ...walk("components")];
  const voidReaders = files.filter((f) => /voided:\s*true|voidReason|voidedBy|voidedAt/.test(readFileSync(f, "utf8")) && !/session-roster\.tsx$/.test(f));
  const auditReaders = files.filter((f) => /auditLogs\.list|auditLog\.findMany/.test(readFileSync(f, "utf8")));
  console.log(`receipt renders paidCount: ${receiptShowsPaid}`);
  console.log(`app/components files reading voided payments: ${voidReaders.length}`);
  console.log(`app/components files reading AuditLog: ${auditReaders.length} ${JSON.stringify(auditReaders)}`);

  const reproduced =
    voided.ok && totals.presentCount === 2 && totals.collected === 0 && !receiptShowsPaid &&
    voidReaders.length === 0 && auditReaders.every((f) => f.includes("(admin)"));
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
