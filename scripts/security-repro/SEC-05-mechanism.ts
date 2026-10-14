/**
 * A10-1b — mechanism check for A10-1 (diagnostic, not a separate finding).
 * Shows that the second desk DOES block on lockAttendeeRow's FOR UPDATE (so the
 * lock works) yet its EXISTS sub-select returns false (statement snapshot taken
 * before the first desk committed), while a fresh statement issued right
 * after the lock returns true. Uses the exact lockAttendeeRow from
 * lib/db/session-lifecycle.ts (imported).
 * Run: node --env-file-if-exists=.env scripts/security-repro/SEC-05-mechanism.ts
 */
import { PrismaClient } from "@prisma/client";
import { createAttendance } from "../../lib/db/attendance.ts";
import { lockAttendeeRow } from "../../lib/db/session-lifecycle.ts";
import { cleanupA10, makeCenter, makeOpenSessionToday, makeStudent } from "./_fixtures.ts";

const prisma = new PrismaClient();
const a = new PrismaClient();
const b = new PrismaClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await cleanupA10(prisma);
  const { center, method, teacher } = await makeCenter(prisma, "1b");
  const session = await makeOpenSessionToday(prisma, center.id, teacher.id);
  const s = await makeStudent(prisma, center.id, "1b", 0);
  const att = await createAttendance(prisma, { centerId: center.id, sessionId: session.id, studentProfileId: s.profile.id, enrollmentId: null, isDropIn: true, recordedBy: teacher.id });
  let t2Out: unknown;
  const t1 = a.$transaction(async (tx) => {
    await lockAttendeeRow(tx, att.id, center.id);
    await sleep(1500);
    await tx.payment.create({ data: { centerId: center.id, sessionId: session.id, sessionAttendeeId: att.id, studentProfileId: s.profile.id, teacherId: teacher.id, amount: 1, paymentMethodId: method.id, methodLabelSnapshot: "Cash", priceSnapshot: 1, centerShareSnapshot: 0, teacherShareSnapshot: 1, recordedBy: teacher.id } });
  }, { timeout: 20000 });
  await sleep(400);
  const t2 = b.$transaction(async (tx) => {
    const started = Date.now();
    const locked = await lockAttendeeRow(tx, att.id, center.id);
    const waited = Date.now() - started;
    const fresh = await tx.payment.count({ where: { sessionAttendeeId: att.id, voided: false } });
    t2Out = { waitedMs: waited, hasActivePaymentFromLockQuery: locked?.hasActivePayment, freshCountAfterLock: fresh };
  }, { timeout: 20000 });
  await Promise.all([t1, t2]);
  console.log(JSON.stringify(t2Out));
  const o = t2Out as { waitedMs: number; hasActivePaymentFromLockQuery: boolean; freshCountAfterLock: number };
  console.log(o.waitedMs > 500 && o.hasActivePaymentFromLockQuery === false && o.freshCountAfterLock === 1 ? "REPRODUCED" : "NOT REPRODUCED");
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { try { await cleanupA10(prisma); } finally { await Promise.all([prisma.$disconnect(), a.$disconnect(), b.$disconnect()]); } });
