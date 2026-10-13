/**
 * Data-visibility window check — the M19 acceptance gate
 * (docs/00-master-product-spec.md §5.1 "Data visibility window",
 * docs/01-data-model.md §7, docs/03-build-order.md M19 "Done when").
 *
 * Run with:  npm run check:visibility
 *
 * Modeled on the receptionist profit-denial shape (docs/02-architecture.md
 * §5: "a loader-level refusal plus a scoped query, asserted directly ...
 * rather than by rendering a page"). Exercises the real production functions
 * — `lib/db/visibility.ts`'s `visibilityWindowFloor`/`clampRangeToVisibility`/
 * `isWithinVisibilityWindow`, combined with `lib/db/analytics.ts` and
 * `lib/db/tenant-scope.ts`'s `scopedWhere` (the exact shape
 * `lib/db/scoped.ts`'s `refunds.list` uses) — against a throwaway center with
 * deliberately old and recent money/session data. Needs a reachable database
 * and cleans up after itself.
 */
import { PrismaClient } from "@prisma/client";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import { revenueTotals } from "../lib/db/analytics.ts";
import { scopedData, scopedWhere } from "../lib/db/tenant-scope.ts";
import {
  DEFAULT_VISIBILITY_WINDOW_DAYS,
  clampRangeToVisibility,
  isWithinVisibilityWindow,
  visibilityWindowFloor,
} from "../lib/db/visibility.ts";
import { startOfUtcDay } from "../lib/scheduling.ts";

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

const SLUG = "visibility-check";

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
  await prisma.user.deleteMany({ where: { email: { startsWith: "visibility-check-" } } });
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: "Visibility-Check" } } });
}

const NOW = new Date("2026-06-15T12:00:00Z");
const WINDOW_DAYS = 14;
const OLD_SESSION_DATE = new Date("2026-04-01T00:00:00Z"); // ~75 days before NOW
const RECENT_SESSION_DATE = new Date("2026-06-10T00:00:00Z"); // 5 days before NOW

async function main() {
  await cleanup();

  // ── 1. Pure date math (no database needed) ────────────────────────────
  console.log("Visibility-window date math (no database needed)");

  check(
    "A platform admin bypasses the window entirely (spec §3: 'Bypasses the data-visibility window')",
    visibilityWindowFloor({ isPlatformAdmin: true, settings: null }, NOW) === null,
  );

  const defaultFloor = visibilityWindowFloor({ isPlatformAdmin: false, settings: null }, NOW);
  check(
    "A centre with no CenterSettings row falls back to the default 30-day window, not unbounded",
    defaultFloor !== null &&
      defaultFloor.getTime() === startOfUtcDay(NOW).getTime() - DEFAULT_VISIBILITY_WINDOW_DAYS * 86_400_000,
    String(defaultFloor),
  );

  const floor14 = visibilityWindowFloor(
    { isPlatformAdmin: false, settings: { dataVisibilityDays: WINDOW_DAYS, timezone: "Africa/Cairo" } },
    NOW,
  );
  check(
    "A centre's own dataVisibilityDays drives the floor — a rolling window ending today, not a calendar-month anchor",
    floor14 !== null &&
      floor14.getTime() === startOfUtcDay(NOW).getTime() - WINDOW_DAYS * 86_400_000,
    String(floor14),
  );

  check(
    "isWithinVisibilityWindow is inclusive at exactly the floor",
    isWithinVisibilityWindow(floor14 as Date, floor14),
  );
  check(
    "isWithinVisibilityWindow refuses one millisecond before the floor",
    !isWithinVisibilityWindow(new Date((floor14 as Date).getTime() - 1), floor14),
  );
  check(
    "isWithinVisibilityWindow is always true when unbounded (floor === null)",
    isWithinVisibilityWindow(new Date("2000-01-01"), null),
  );

  const wideRequest = { start: new Date("2020-01-01"), end: NOW };
  const clamped = clampRangeToVisibility(wideRequest, floor14);
  check(
    "clampRangeToVisibility raises a manipulated ?from= far in the past up to the window floor — the direct-URL bypass this milestone closes",
    clamped.start.getTime() === (floor14 as Date).getTime() && clamped.end.getTime() === NOW.getTime(),
    JSON.stringify(clamped),
  );

  const narrowRequest = { start: new Date("2026-06-12"), end: NOW };
  const unclamped = clampRangeToVisibility(narrowRequest, floor14);
  check(
    "clampRangeToVisibility never narrows a range that was already inside the window",
    unclamped.start.getTime() === narrowRequest.start.getTime(),
  );

  check(
    "clampRangeToVisibility is a no-op when the floor is null (platform admin bypass)",
    clampRangeToVisibility(wideRequest, null).start.getTime() === wideRequest.start.getTime(),
  );

  // ── 2. Database-backed: the denial actually excludes old data, and       ──
  //      nothing was ever deleted to make that true                        ──
  console.log("\nDatabase-backed checks");

  const center = await prisma.center.create({
    data: {
      slug: SLUG,
      name: "Visibility Check",
      organization: { create: { name: "Visibility Check" } },
      settings: { create: { dataVisibilityDays: WINDOW_DAYS } },
    },
  });

  const teacherUser = await prisma.user.create({
    data: { firstName: "T", lastName: "Visibility", email: "visibility-check-teacher@kayedu.test", locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(center.id, {
      userId: teacherUser.id,
      role: "TEACHER",
      firstName: "T",
      lastName: "Visibility",
      email: "visibility-check-teacher@kayedu.test",
      joinedAt: OLD_SESSION_DATE,
    }),
  });
  const studentUser = await prisma.user.create({
    data: { firstName: "S", lastName: "Visibility", locale: "en" },
  });
  const student = await prisma.studentProfile.create({
    data: scopedData(center.id, {
      userId: studentUser.id,
      studentCode: "VIS-1001",
      firstName: "S",
      lastName: "Visibility",
    }),
  });
  const subject = await prisma.catalogSubject.create({
    data: { nameAr: "Visibility-Check Math", nameEn: "Visibility-Check Math" },
  });
  const classGroup = await prisma.classGroup.create({
    data: scopedData(center.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId: teacherUser.id,
      subjectId: subject.id,
      price: 10_000,
    }),
  });

  async function makeSessionWithPayment(date: Date, startTime = "16:00", endTime = "17:00") {
    const session = await prisma.session.create({
      data: scopedData(center.id, {
        classGroupId: classGroup.id,
        teacherId: teacherUser.id,
        date,
        startTime,
        endTime,
        priceSnapshot: 10_000,
      }),
    });
    const attendee = await createAttendance(prisma, {
      centerId: center.id,
      sessionId: session.id,
      studentProfileId: student.id,
      enrollmentId: null,
      isDropIn: true,
      recordedBy: teacherUser.id,
    }, { historicalBackfill: true, status: "PRESENT" });
    const methodId = await fixtureMethodId(center.id);
    const result = await prisma.$transaction((tx) =>
      recordPayment(tx, center.id, attendee.id, methodId, teacherUser.id, { historicalBackfill: true }),
    );
    if (!result.ok) throw new Error(`recordPayment failed: ${result.error}`);
    return { session, payment: result.payment };
  }

  const oldFixture = await makeSessionWithPayment(OLD_SESSION_DATE);
  const recentFixture = await makeSessionWithPayment(RECENT_SESSION_DATE);

  // Separate, deliberately-refunded fixtures for the Refund-windowing checks
  // below — kept apart from oldFixture/recentFixture above so refundTotals'
  // own subtraction (keyed on the underlying session's date, not
  // refundedAt) doesn't zero out the revenue-window assertion's numbers.
  const oldRefundedFixture = await makeSessionWithPayment(OLD_SESSION_DATE, "18:00", "19:00");
  const recentRefundedFixture = await makeSessionWithPayment(RECENT_SESSION_DATE, "18:00", "19:00");

  // Refund is NOT a carve-out (only settlement/payout and audit logs are,
  // spec §5.1) — an old refund must be excluded by the same windowing
  // `lib/db/scoped.ts`'s `refunds.list` applies.
  const oldRefund = await prisma.refund.create({
    data: {
      centerId: center.id,
      paymentId: oldRefundedFixture.payment.id,
      teacherId: teacherUser.id,
      amount: oldRefundedFixture.payment.amount,
      centerShareReversed: oldRefundedFixture.payment.centerShareSnapshot,
      teacherShareReversed: oldRefundedFixture.payment.teacherShareSnapshot,
      reason: "Visibility check fixture",
      refundedBy: teacherUser.id,
      refundedAt: OLD_SESSION_DATE,
    },
  });
  const recentRefund = await prisma.refund.create({
    data: {
      centerId: center.id,
      paymentId: recentRefundedFixture.payment.id,
      teacherId: teacherUser.id,
      amount: recentRefundedFixture.payment.amount,
      centerShareReversed: recentRefundedFixture.payment.centerShareSnapshot,
      teacherShareReversed: recentRefundedFixture.payment.teacherShareSnapshot,
      reason: "Visibility check fixture",
      refundedBy: teacherUser.id,
      refundedAt: RECENT_SESSION_DATE,
    },
  });

  // Settlement — a payout carve-out (spec §5.1: "a teacher must always
  // verify they were paid").
  const oldSettlement = await prisma.settlement.create({
    data: {
      centerId: center.id,
      teacherId: teacherUser.id,
      sessionId: oldFixture.session.id,
      totalAmount: oldFixture.payment.teacherShareSnapshot,
      status: "PAID",
      createdBy: teacherUser.id,
      createdAt: OLD_SESSION_DATE,
    },
  });

  // AuditLog — the other carve-out.
  const oldAuditLog = await prisma.auditLog.create({
    data: {
      centerId: center.id,
      actorUserId: teacherUser.id,
      action: "visibility-check.fixture",
      entityType: "Session",
      entityId: oldFixture.session.id,
      createdAt: OLD_SESSION_DATE,
    },
  });

  const floor = visibilityWindowFloor(
    { isPlatformAdmin: false, settings: { dataVisibilityDays: WINDOW_DAYS, timezone: "Africa/Cairo" } },
    NOW,
  ) as Date;

  // Simulate a manipulated `?from=`/`?range=all` request reaching all the way
  // back — clamped exactly the way Sessions/Analytics/Expenses clamp it.
  const requestedRange = clampRangeToVisibility({ start: OLD_SESSION_DATE, end: NOW }, floor);

  const revenue = await revenueTotals(prisma, center.id, {
    from: requestedRange.start,
    to: requestedRange.end,
  });
  check(
    "revenueTotals with the clamped range counts only the two recent payments, not the two old ones",
    revenue.paymentCount === 2 && revenue.collected === recentFixture.payment.amount,
    JSON.stringify(revenue),
  );

  const unclampedRevenue = await revenueTotals(prisma, center.id, {
    from: OLD_SESSION_DATE,
    to: NOW,
  });
  check(
    "Sanity check: without clamping, all four payments would have counted — proving the clamp is what excluded the old ones, not the fixtures themselves",
    unclampedRevenue.paymentCount === 4,
    JSON.stringify(unclampedRevenue),
  );

  // The exact shape lib/db/scoped.ts's refunds.list uses.
  const visibleRefunds = await prisma.refund.findMany({
    where: scopedWhere(center.id, { refundedAt: { gte: floor } }),
  });
  check(
    "Refund reads windowed the same way — the old refund is excluded, the recent one is not",
    visibleRefunds.length === 1 &&
      visibleRefunds[0]?.id === recentRefund.id &&
      !visibleRefunds.some((r) => r.id === oldRefund.id),
    JSON.stringify(visibleRefunds.map((r) => r.id)),
  );

  // Settlement/audit reads apply NO date filter at all (lib/db/scoped.ts's
  // settlements.list / auditLogs.list) — an old row must still come back.
  const visibleSettlements = await prisma.settlement.findMany({
    where: scopedWhere(center.id),
  });
  check(
    "Settlement carve-out: an old settlement is still readable regardless of the window",
    visibleSettlements.some((s) => s.id === oldSettlement.id),
  );
  const visibleAuditLogs = await prisma.auditLog.findMany({
    where: { centerId: center.id },
  });
  check(
    "Audit-log carve-out: an old audit row is still readable regardless of the window",
    visibleAuditLogs.some((a) => a.id === oldAuditLog.id),
  );

  // ── 3. Nothing is deleted — widening restores visibility instantly ──────
  const oldSessionStillExists = await prisma.session.findUnique({ where: { id: oldFixture.session.id } });
  const oldPaymentStillExists = await prisma.payment.findUnique({ where: { id: oldFixture.payment.id } });
  check(
    "The out-of-window session/payment rows were never pruned — only excluded from the windowed read",
    oldSessionStillExists !== null && oldPaymentStillExists !== null,
  );

  await prisma.centerSettings.update({
    where: { centerId: center.id },
    data: { dataVisibilityDays: 200 },
  });
  const widenedFloor = visibilityWindowFloor(
    { isPlatformAdmin: false, settings: { dataVisibilityDays: 200, timezone: "Africa/Cairo" } },
    NOW,
  ) as Date;
  const widenedRange = clampRangeToVisibility({ start: OLD_SESSION_DATE, end: NOW }, widenedFloor);
  const revenueAfterWidening = await revenueTotals(prisma, center.id, {
    from: widenedRange.start,
    to: widenedRange.end,
  });
  check(
    "Widening the window restores full visibility on the very next read, with zero backfill — nothing was ever lost",
    revenueAfterWidening.paymentCount === 4,
    JSON.stringify(revenueAfterWidening),
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
      console.error(`\n${failures} visibility check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll visibility checks passed.");
  });
