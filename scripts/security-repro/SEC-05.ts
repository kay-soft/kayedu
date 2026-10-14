/**
 * A10-1 — "at most one active (non-voided) payment per attendee" is broken by
 * two concurrent recordPayment calls (two reception desks scanning the same
 * card with a payment method selected, or a double-submit).
 *
 * IMPORTED, not replicated: `recordPayment` from lib/db/payments.ts (the
 * function app/[locale]/(center)/reception/actions.ts:323-326 and
 * app/[locale]/(center)/sessions/actions.ts:514-517 call), wrapped exactly as
 * those actions wrap it: `prisma.$transaction(tx => recordPayment(...),
 * WRITE_TRANSACTION_OPTIONS)` — default READ COMMITTED isolation.
 *
 * Why it breaks: the guard is `lockAttendeeRow` (lib/db/session-lifecycle.ts:285-298),
 *   SELECT a.*, EXISTS (SELECT 1 FROM "Payment" p WHERE ... voided = false)
 *   FROM "SessionAttendee" a WHERE a.id = $1 FOR UPDATE OF a
 * Under READ COMMITTED the statement's snapshot is taken when the statement
 * STARTS. The second desk's statement starts, blocks on the row lock held by
 * the first, and when the first commits it gets the lock — but the attendee
 * row itself was never updated by the first transaction (it only INSERTed a
 * Payment), so no EvalPlanQual re-read happens and the EXISTS sub-select was
 * evaluated against the pre-commit snapshot: hasActivePayment = false.
 * There is no partial unique index on Payment(sessionAttendeeId) WHERE NOT
 * voided (migration 20260901210619_m5 dropped the only unique index).
 *
 * Two separate PrismaClient instances stand in for two server instances /
 * two desks (each Vercel instance has its own pool).
 *
 * Run: node --env-file-if-exists=.env scripts/security-repro/SEC-05.ts
 * Fixtures: centre slug `secrepro-a10-1`, users `secrepro-a10-1-*@kayedu.test`,
 * pre-cleaned and deleted in finally.
 */
import { PrismaClient } from "@prisma/client";
import { createAttendance } from "../../lib/db/attendance.ts";
import { recordPayment } from "../../lib/db/payments.ts";
import { WRITE_TRANSACTION_OPTIONS } from "../../lib/db/session-lifecycle.ts";
import { cleanupA10, makeCenter, makeOpenSessionToday, makeStudent } from "./_fixtures.ts";

const prisma = new PrismaClient();
const deskA = new PrismaClient();
const deskB = new PrismaClient();
const ROUNDS = 6;

async function main() {
  await cleanupA10(prisma);
  const { center, method, teacher } = await makeCenter(prisma, "1");
  const session = await makeOpenSessionToday(prisma, center.id, teacher.id);

  let duplicated = 0;
  const results: string[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const s = await makeStudent(prisma, center.id, "1", i);
    // Fixture check-in through the real (non-backfill) path.
    const attendee = await createAttendance(prisma, {
      centerId: center.id,
      sessionId: session.id,
      studentProfileId: s.profile.id,
      enrollmentId: null,
      isDropIn: true,
      recordedBy: teacher.id,
    });

    const desk = (client: PrismaClient) =>
      client.$transaction(
        (tx) => recordPayment(tx, center.id, attendee.id, method.id, teacher.id),
        WRITE_TRANSACTION_OPTIONS,
      );
    const [a, b] = await Promise.all([desk(deskA), desk(deskB)]);

    const active = await prisma.payment.count({
      where: { centerId: center.id, sessionAttendeeId: attendee.id, voided: false },
    });
    results.push(
      `round ${i}: deskA=${a.ok ? "ok" : a.error} deskB=${b.ok ? "ok" : b.error} activePayments=${active}`,
    );
    if (active > 1) duplicated++;
  }
  for (const line of results) console.log(line);
  const totalActive = await prisma.payment.aggregate({
    where: { centerId: center.id, sessionId: session.id, voided: false },
    _sum: { amount: true },
    _count: true,
  });
  console.log(
    `attendees=${ROUNDS} activePayments=${totalActive._count} collected(piastres)=${totalActive._sum.amount}`,
  );
  console.log(`attendees with >1 non-voided payment: ${duplicated}/${ROUNDS}`);
  console.log(duplicated > 0 ? "REPRODUCED" : "NOT REPRODUCED");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanupA10(prisma);
    } finally {
      await Promise.all([prisma.$disconnect(), deskA.$disconnect(), deskB.$disconnect()]);
    }
  });
