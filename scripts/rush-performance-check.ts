/**
 * Rush-performance check — the M10 acceptance gate for spec §7 acceptance
 * criterion 14: "High-volume attendance entry during a rush stays
 * responsive."
 *
 * Run with:  npm run check:performance
 *
 * This is not a browser/UI benchmark (CLAUDE.md rule 1: no browser testing) —
 * it validates the thing docs/02-architecture.md §14 actually flags as the
 * risk: that concurrent independent attendance+payment writes, fired the way
 * a busy Reception Desk fires them (several receptionists checking students
 * in at once), truly run *concurrently* against the pooled connection rather
 * than silently serializing behind an exhausted client-side pool. It:
 *
 *   1. Asserts `DATABASE_URL` carries an explicit `connection_limit` (the
 *      exact fix §14 documents for the pgbouncer prepared-statement cost).
 *   2. Times a small *serial* batch of real `createAttendance` +
 *      `recordPayment` calls (the same functions the Reception Desk and
 *      session-roster Server Actions call) to get a realistic per-operation
 *      cost on this machine/database — no hardcoded absolute-ms budget,
 *      which would be flaky across machines and CI runners.
 *   3. Times a larger *concurrent* batch (`Promise.all`) of the same
 *      operations against a fresh set of students/attendees, and asserts it
 *      completes well under what naive serial extrapolation would predict —
 *      proof the pool is actually granting concurrency, not queuing.
 *   4. Asserts every concurrent write actually landed correctly (no lost
 *      updates, no duplicate/second active payment) — a rush that corrupts
 *      money under load is worse than a rush that is merely slow.
 *
 * Needs a reachable database and cleans up after itself.
 */
import { PrismaClient } from "@prisma/client";
import { scopedData, scopedWhere } from "../lib/db/tenant-scope.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import { WRITE_TRANSACTION_OPTIONS } from "../lib/db/session-lifecycle.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";

const prisma = new PrismaClient();

/** R1 fixture shape: a centre's first active payment method, created on demand. */
const fixtureMethodIds = new Map<string, string>();
async function fixtureMethodId(centerId: string): Promise<string> {
  const cached = fixtureMethodIds.get(centerId);
  if (cached) return cached;
  await ensureDefaultPaymentMethods(prisma, centerId);
  const [method] = await listActivePaymentMethods(prisma, centerId);
  fixtureMethodIds.set(centerId, method.id);
  return method.id;
}

const SLUG = "rush-performance-check";
const SERIAL_COUNT = 6;
const CONCURRENT_COUNT = 30;
/**
 * Concurrency must beat this fraction of the naive serial-extrapolation
 * time. 0.6 leaves generous headroom above pure network/DB variance while
 * still failing hard if operations are effectively serializing (which
 * would land close to 1.0, or above it once concurrent-batch overhead is
 * added).
 */
const CONCURRENCY_BUDGET_FRACTION = 0.6;

let failures = 0;

function check(name: string, passed: boolean, detail = "") {
  if (passed) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function cleanup() {
  await prisma.center.deleteMany({ where: { slug: SLUG } });
  await prisma.user.deleteMany({ where: { email: { startsWith: `${SLUG}-` } } });
}

async function makeStudents(centerId: string, count: number, tagPrefix: string) {
  const students: { userId: string; profileId: string }[] = [];
  for (let i = 0; i < count; i++) {
    const code = `${tagPrefix}${i}`;
    const user = await prisma.user.create({
      data: { firstName: "S", lastName: code, locale: "en" },
    });
    const profile = await prisma.studentProfile.create({
      data: scopedData(centerId, {
        userId: user.id,
        studentCode: `${SLUG}-${code}`,
        firstName: "S",
        lastName: code,
      }),
    });
    students.push({ userId: user.id, profileId: profile.id });
  }
  return students;
}

/** One "check a student in" op: mark PRESENT, then record the payment — the
 * exact two-write shape the Reception Desk / session roster fire per student. */
async function checkIn(centerId: string, sessionId: string, studentProfileId: string, actorId: string) {
  const attendee = await createAttendance(prisma, {
    centerId,
    sessionId,
    studentProfileId,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const methodId = await fixtureMethodId(centerId);
  const result = await prisma.$transaction(
    (tx) => recordPayment(tx, centerId, attendee.id, methodId, actorId, { historicalBackfill: true }),
    WRITE_TRANSACTION_OPTIONS,
  );
  return { attendee, result };
}

async function main() {
  await cleanup();

  console.log("Connection pool configuration");
  const databaseUrl = process.env.DATABASE_URL ?? "";
  check(
    "DATABASE_URL sets an explicit connection_limit (docs/02-architecture.md §14)",
    /[?&]connection_limit=\d+/.test(databaseUrl),
    databaseUrl
      ? "no connection_limit param found on DATABASE_URL"
      : "DATABASE_URL is not set — cannot verify pool sizing",
  );

  console.log("\nRush simulation (real createAttendance + recordPayment writes)");

  const center = await prisma.center.create({
    data: {
      slug: SLUG,
      name: "Rush Performance Check",
      organization: { create: { name: "Rush Performance Check" } },
    },
  });
  await prisma.centerSettings.create({
    data: { centerId: center.id, defaultShareType: "PERCENTAGE", defaultShareValue: 15 },
  });
  const teacherUser = await prisma.user.create({
    data: { firstName: "T", lastName: "Rush", email: `${SLUG}-teacher@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(center.id, {
      userId: teacherUser.id,
      role: "TEACHER",
      firstName: "T",
      lastName: "Rush",
      joinedAt: new Date(),
    }),
  });
  const classGroup = await prisma.classGroup.create({
    data: scopedData(center.id, { startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), teacherId: teacherUser.id, price: 10_000 }),
  });
  const session = await prisma.session.create({
    data: scopedData(center.id, {
      classGroupId: classGroup.id,
      teacherId: teacherUser.id,
      date: new Date(),
      startTime: "09:00",
      endTime: "10:00",
      priceSnapshot: 10_000,
    }),
  });
  const actorId = teacherUser.id;

  // ── Serial baseline ────────────────────────────────────────────────────
  const serialStudents = await makeStudents(center.id, SERIAL_COUNT, "serial");
  const serialStart = performance.now();
  for (const student of serialStudents) {
    const outcome = await checkIn(center.id, session.id, student.profileId, actorId);
    if (!outcome.result.ok) {
      throw new Error(`Serial check-in failed unexpectedly: ${outcome.result.error}`);
    }
  }
  const serialElapsedMs = performance.now() - serialStart;
  const serialPerOpMs = serialElapsedMs / SERIAL_COUNT;
  console.log(
    `  INFO  Serial baseline: ${SERIAL_COUNT} check-ins in ${serialElapsedMs.toFixed(0)}ms (${serialPerOpMs.toFixed(1)}ms/op)`,
  );

  // ── Concurrent rush ────────────────────────────────────────────────────
  const concurrentStudents = await makeStudents(center.id, CONCURRENT_COUNT, "rush");
  const concurrentStart = performance.now();
  const outcomes = await Promise.all(
    concurrentStudents.map((student) => checkIn(center.id, session.id, student.profileId, actorId)),
  );
  const concurrentElapsedMs = performance.now() - concurrentStart;
  console.log(
    `  INFO  Concurrent rush: ${CONCURRENT_COUNT} check-ins in ${concurrentElapsedMs.toFixed(0)}ms (${(concurrentElapsedMs / CONCURRENT_COUNT).toFixed(1)}ms/op wall-clock)`,
  );

  const allSucceeded = outcomes.every((outcome) => outcome.result.ok);
  check(
    `All ${CONCURRENT_COUNT} concurrent check-ins succeeded with no errors`,
    allSucceeded,
    JSON.stringify(outcomes.filter((o) => !o.result.ok).map((o) => (o.result as { error: string }).error)),
  );

  const naiveSerialExtrapolationMs = serialPerOpMs * CONCURRENT_COUNT;
  const budgetMs = naiveSerialExtrapolationMs * CONCURRENCY_BUDGET_FRACTION;
  check(
    `Concurrent rush (${concurrentElapsedMs.toFixed(0)}ms) beats ${(CONCURRENCY_BUDGET_FRACTION * 100).toFixed(0)}% of naive serial extrapolation (${budgetMs.toFixed(0)}ms of ${naiveSerialExtrapolationMs.toFixed(0)}ms) — the pool is granting real concurrency, not queuing`,
    concurrentElapsedMs < budgetMs,
    `concurrent=${concurrentElapsedMs.toFixed(0)}ms budget=${budgetMs.toFixed(0)}ms`,
  );

  // ── Correctness under concurrency: no lost writes, no double payments ──
  const attendeeCount = await prisma.sessionAttendee.count({
    where: scopedWhere(center.id, { sessionId: session.id }),
  });
  check(
    "Every concurrent check-in produced exactly one SessionAttendee row (no lost/duplicate writes)",
    attendeeCount === SERIAL_COUNT + CONCURRENT_COUNT,
    `expected ${SERIAL_COUNT + CONCURRENT_COUNT}, got ${attendeeCount}`,
  );

  const activePaymentCount = await prisma.payment.count({
    where: scopedWhere(center.id, { sessionId: session.id, voided: false }),
  });
  check(
    "Every concurrent check-in produced exactly one active Payment row",
    activePaymentCount === SERIAL_COUNT + CONCURRENT_COUNT,
    `expected ${SERIAL_COUNT + CONCURRENT_COUNT}, got ${activePaymentCount}`,
  );

  const revenueAgg = await prisma.payment.aggregate({
    where: scopedWhere(center.id, { sessionId: session.id, voided: false }),
    _sum: { amount: true },
  });
  check(
    "Total collected under the rush reconciles exactly (no torn/partial writes)",
    revenueAgg._sum.amount === (SERIAL_COUNT + CONCURRENT_COUNT) * 10_000,
    `expected ${(SERIAL_COUNT + CONCURRENT_COUNT) * 10_000}, got ${revenueAgg._sum.amount}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
    if (failures > 0) {
      console.error(`\n${failures} rush-performance check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll rush-performance checks passed.");
  });
