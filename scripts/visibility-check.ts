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
import { gatePrisma } from "./lib/gate-db.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import { revenueByTeacher, revenueTotals } from "../lib/db/analytics.ts";
import { scopedData, scopedWhere } from "../lib/db/tenant-scope.ts";
import {
  DEFAULT_CENTER_VISIBILITY_DAYS,
  DEFAULT_TEACHER_VISIBILITY_DAYS,
  MAX_CENTER_VISIBILITY_DAYS,
  MAX_TEACHER_HISTORY_DAYS,
  MAX_TEACHER_VISIBILITY_DAYS,
  clampRangeToVisibility,
  isWithinVisibilityWindow,
  teacherHistoryFloor,
  teacherVisibilityWindowFloor,
  visibilityWindowFloor,
} from "../lib/db/visibility.ts";
import { teacherPortalHistoryFloor, teacherStudentProfileIds } from "../lib/db/teacher-portal.ts";
import { generalSettingsSchema } from "../lib/validation/settings.ts";
import { centerVisibilityWindowSchema } from "../lib/validation/admin.ts";
import { teacherHistorySchema } from "../lib/validation/account.ts";
import { startOfUtcDay } from "../lib/scheduling.ts";
import { scopedIgnoringVisibilityWindow, scopedWith } from "../lib/db/scoped.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const prisma = await gatePrisma();

/** Every .ts/.tsx file under `dir`. */
function listTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listTs(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path.replaceAll("\\", "/"));
  }
  return out;
}

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
/** U6: the teacher window in this fixture — narrower than the centre's 14. */
const TEACHER_WINDOW_DAYS = 7;
/** The two windows as a context's settings carry them (U6). */
const windows = (center: number, teacher = TEACHER_WINDOW_DAYS) => ({
  centerDataVisibilityDays: center,
  teacherDataVisibilityDays: teacher,
  timezone: "Africa/Cairo",
});
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
  const defaultTeacherFloor = teacherVisibilityWindowFloor({ isPlatformAdmin: false, settings: null }, NOW);
  check(
    "A centre with no CenterSettings row falls back to each window's default (centre 365, teacher 30), not unbounded",
    DEFAULT_CENTER_VISIBILITY_DAYS === 365 &&
      DEFAULT_TEACHER_VISIBILITY_DAYS === 30 &&
      defaultFloor !== null &&
      defaultFloor.getTime() === startOfUtcDay(NOW).getTime() - DEFAULT_CENTER_VISIBILITY_DAYS * 86_400_000 &&
      defaultTeacherFloor !== null &&
      defaultTeacherFloor.getTime() === startOfUtcDay(NOW).getTime() - DEFAULT_TEACHER_VISIBILITY_DAYS * 86_400_000,
    `${String(defaultFloor)} / ${String(defaultTeacherFloor)}`,
  );

  const floor14 = visibilityWindowFloor({ isPlatformAdmin: false, settings: windows(WINDOW_DAYS) }, NOW);
  check(
    "A centre's own centerDataVisibilityDays drives the centre floor — a rolling window ending today, not a calendar-month anchor",
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
      settings: { create: { centerDataVisibilityDays: WINDOW_DAYS, teacherDataVisibilityDays: TEACHER_WINDOW_DAYS } },
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

  const floor = visibilityWindowFloor({ isPlatformAdmin: false, settings: windows(WINDOW_DAYS) }, NOW) as Date;

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

  // ── 2b. SEC-62: the floor is in the scoped helpers, for every centre-side ─
  //       role, by direct call — the same objects every page and action    ─
  //       reads through (lib/db/scoped.ts), not a page-level clamp.        ─
  console.log("\nSEC-62 — the scoped helpers apply the window beside centerId");
  const category = await prisma.expenseCategory.create({ data: scopedData(center.id, { name: "Visibility-Check" }) });
  const oldExpense = await prisma.expense.create({
    data: scopedData(center.id, { categoryId: category.id, amount: 5_000, date: OLD_SESSION_DATE, recordedBy: teacherUser.id }),
  });
  const recentExpense = await prisma.expense.create({
    data: scopedData(center.id, { categoryId: category.id, amount: 6_000, date: RECENT_SESSION_DATE, recordedBy: teacherUser.id }),
  });
  await prisma.sessionAttendanceChange.create({
    data: scopedData(center.id, {
      sessionId: oldFixture.session.id,
      studentProfileId: student.id,
      fromStatus: "PRESENT",
      toStatus: "LATE",
      changedBy: teacherUser.id,
      changedAt: OLD_SESSION_DATE,
    }),
  });
  const oldAttendee = await prisma.sessionAttendee.findFirstOrThrow({ where: { sessionId: oldFixture.session.id } });
  const recentAttendee = await prisma.sessionAttendee.findFirstOrThrow({ where: { sessionId: recentFixture.session.id } });
  const scopeFor = (role: string, extra: { isPlatformAdmin?: boolean } = {}) =>
    scopedWith(
      prisma,
      {
        center: { id: center.id },
        user: { locale: "en" },
        role,
        isPlatformAdmin: extra.isPlatformAdmin ?? false,
        settings: windows(WINDOW_DAYS),
      },
      { now: NOW },
    );

  for (const role of ["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT"]) {
    const db = scopeFor(role);
    const refusedById = [
      await db.sessions.findById(oldFixture.session.id),
      await db.sessions.findDetailById(oldFixture.session.id),
      await db.sessions.findForEdit(oldFixture.session.id),
      await db.attendees.findById(oldAttendee.id),
      await db.attendees.findDetailById(oldAttendee.id),
      await db.attendees.findExisting(oldFixture.session.id, student.id),
      await db.payments.findById(oldFixture.payment.id),
      await db.expenses.findById(oldExpense.id),
    ].every((row) => row === null);
    check(`${role}: an out-of-window session, attendee, payment or expense by direct id is refused (null, like another centre's id)`, refusedById);
    const recentReadable =
      (await db.sessions.findById(recentFixture.session.id)) !== null &&
      (await db.attendees.findById(recentAttendee.id)) !== null &&
      (await db.payments.findById(recentFixture.payment.id)) !== null &&
      (await db.expenses.findById(recentExpense.id)) !== null;
    check(`${role}: the in-window rows of the same kinds still read`, recentReadable);
    const listed = await db.sessions.search({ where: {} });
    const counts = {
      sessions: await db.sessions.count(),
      attendees: await db.attendees.count(),
      payments: await db.payments.count(),
      expenses: await db.expenses.count(),
      expenseRows: (await db.expenses.search({ where: {}, take: 50 })).length,
    };
    check(
      `${role}: lists and counts carry the floor too (an unbounded ?from= cannot reach past it)`,
      listed.every((row) => row.id !== oldFixture.session.id && row.id !== oldRefundedFixture.session.id) &&
        listed.length === 2 && counts.sessions === 2 && counts.attendees === 2 && counts.payments === 2 &&
        counts.expenses === 1 && counts.expenseRows === 1,
      JSON.stringify(counts),
    );
    check(
      `${role}: an out-of-window session's change log reads as empty`,
      (await db.attendanceChanges.listForSession(oldFixture.session.id)).length === 0 &&
        (await db.attendanceChanges.count()) === 0,
    );
    check(
      `${role}: refunds.list is windowed by the same floor`,
      (await db.refunds.list()).map((r) => r.id).join() === recentRefund.id,
    );
    check(
      `${role}: settlements and audit logs stay carved out (old rows still read)`,
      (await db.settlements.list()).some((s) => s.id === oldSettlement.id) &&
        (await db.auditLogs.list(500)).some((a) => a.id === oldAuditLog.id) &&
        (await db.settlements.findForSession(oldFixture.session.id))?.id === oldSettlement.id,
    );
  }

  for (const role of ["TEACHER", "STUDENT", "PARENT"]) {
    check(
      `${role}: never windowed — the old session reads (docs/01 §7)`,
      (await scopeFor(role).sessions.findById(oldFixture.session.id)) !== null,
    );
  }
  check(
    "A platform admin bypasses the floor in the scoped helpers too",
    (await scopeFor("OWNER", { isPlatformAdmin: true }).sessions.findById(oldFixture.session.id)) !== null,
  );
  const integrity = scopedIgnoringVisibilityWindow(
    { center: { id: center.id }, user: { locale: "en" }, role: "MANAGER", isPlatformAdmin: false, settings: windows(WINDOW_DAYS) },
    "integrity",
    prisma,
  );
  check(
    "The named opt-out (scopedIgnoringVisibilityWindow) sees the whole history — what delete blockers count",
    (await integrity.sessions.count()) === 4 && (await integrity.payments.count()) === 4 && integrity.visibilityFloor === null,
  );
  check(
    "The absence streak counts back no further than the floor (scoped attendees.absenceStreak)",
    await (async () => {
      const streakClass = await prisma.classGroup.create({
        data: scopedData(center.id, { startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), teacherId: teacherUser.id, price: 10_000 }),
      });
      const absent = async (date: Date) => {
        const s = await prisma.session.create({
          data: scopedData(center.id, { classGroupId: streakClass.id, teacherId: teacherUser.id, date, startTime: "08:00", endTime: "09:00", priceSnapshot: 10_000 }),
        });
        await prisma.sessionAttendee.create({
          data: scopedData(center.id, { sessionId: s.id, studentProfileId: student.id, attendanceStatus: "ABSENT", isDropIn: false, recordedBy: "system" }),
        });
      };
      await absent(new Date("2026-05-20T00:00:00Z")); // before the 14-day floor (1 June)
      await absent(new Date("2026-05-25T00:00:00Z")); // before it
      await absent(new Date("2026-06-12T00:00:00Z")); // inside it
      const windowed = await scopeFor("MANAGER").attendees.absenceStreak(streakClass.id, student.id, NOW);
      const unbounded = await scopeFor("TEACHER").attendees.absenceStreak(streakClass.id, student.id, NOW);
      return windowed === 1 && unbounded === 3;
    })(),
  );
  check(
    "Static: every centre page reads sessions/attendees/payments/expenses through scoped helpers — no direct prisma.session/payment/sessionAttendee/expense read under app/(center) or app/(print)",
    !listTs("app/[locale]/(center)").concat(listTs("app/[locale]/(print)")).some((file) =>
      /\bprisma\.(session|payment|sessionAttendee|expense|sessionAttendanceChange)\.(find|count|aggregate|groupBy)/.test(readFileSync(file, "utf8")),
    ),
  );
  check(
    "Static: the opt-out is only used with a stated reason, and only for integrity, settlement or audit reads",
    listTs("app").concat(listTs("lib")).every((file) => {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      return [...source.matchAll(/scopedIgnoringVisibilityWindow\(([^)]*)\)/g)].every((m) =>
        /"(integrity|settlement|audit)"/.test(m[1]) || file.endsWith("lib/db/scoped.ts"),
      );
    }),
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
    data: { centerDataVisibilityDays: 200 },
  });
  const widenedFloor = visibilityWindowFloor({ isPlatformAdmin: false, settings: windows(200) }, NOW) as Date;
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

  // ── 4. U6: two windows, each read on its own; caps; the teacher's own ───
  //      portal preference                                                ─
  console.log("\nU6 — the centre window, the teacher window and the teacher portal preference");

  // Independent windows (decided 29 Oct): the teacher window neither caps nor is capped by the centre's.
  const wideCentre = windows(200, TEACHER_WINDOW_DAYS);
  const centreFloor200 = visibilityWindowFloor({ isPlatformAdmin: false, settings: wideCentre }, NOW) as Date;
  const teacherFloor7 = teacherVisibilityWindowFloor({ isPlatformAdmin: false, settings: wideCentre }, NOW) as Date;
  check(
    "The teacher window reads teacherDataVisibilityDays, the centre window centerDataVisibilityDays",
    centreFloor200.getTime() === startOfUtcDay(NOW).getTime() - 200 * 86_400_000 &&
      teacherFloor7.getTime() === startOfUtcDay(NOW).getTime() - TEACHER_WINDOW_DAYS * 86_400_000,
  );
  const narrowCentre = windows(3, 30);
  check(
    "The windows are independent: a teacher window wider than the centre's is not narrowed to it",
    (teacherVisibilityWindowFloor({ isPlatformAdmin: false, settings: narrowCentre }, NOW) as Date).getTime() <
      (visibilityWindowFloor({ isPlatformAdmin: false, settings: narrowCentre }, NOW) as Date).getTime(),
  );
  check(
    "A platform admin bypasses the teacher window too",
    teacherVisibilityWindowFloor({ isPlatformAdmin: true, settings: wideCentre }, NOW) === null,
  );

  // Each read uses its window, by direct call: with the centre at 200 days and
  // the teacher window at 7, the branch total reaches the old payments, the
  // per-teacher breakdown and the teacher-filtered total do not.
  const teacherRange = clampRangeToVisibility({ start: OLD_SESSION_DATE, end: NOW }, teacherFloor7);
  const breakdown = await revenueByTeacher(prisma, center.id, { from: teacherRange.start, to: teacherRange.end });
  const filtered = await revenueTotals(prisma, center.id, { from: teacherRange.start, to: teacherRange.end }, teacherUser.id);
  check(
    "Teacher window: the by-teacher breakdown and the teacher-filtered total count only the last 7 days (2 payments), while the centre window counts all 4",
    breakdown.length === 1 && breakdown[0]?.paymentCount === 2 && filtered.paymentCount === 2 && revenueAfterWidening.paymentCount === 4,
    JSON.stringify({ breakdown, filtered: filtered.paymentCount }),
  );

  const analyticsPage = readFileSync("app/[locale]/(center)/analytics/page.tsx", "utf8");
  check(
    "Static: Analytics clamps to the teacher window when a teacher is selected, the centre window otherwise",
    /teacherSelected \? teacherVisibilityWindowFloor\(ctx, now\) : visibilityWindowFloor\(ctx, now\)/.test(analyticsPage),
  );
  check(
    "Static: the Analytics by-teacher breakdown reads under the teacher window even on the unfiltered page",
    /revenueByTeacher\(prisma, centerId, \{ from: breakdownFrom, to: breakdownTo \}\)/.test(analyticsPage) &&
      /breakdownFrom, end: breakdownTo \} = clampRangeToVisibility\(\s*requested,\s*teacherVisibilityWindowFloor\(ctx, now\)/.test(analyticsPage),
  );
  check(
    "Static: the roll-up applies each branch's own teacher window when a teacher is selected",
    /teacherSelected\s*\?\s*teacherVisibilityWindowFloor\(\{ isPlatformAdmin: ctx\.isPlatformAdmin, settings \}, now\)/.test(analyticsPage),
  );
  check(
    "Static: Sessions, Expenses and the audit unpaid list read under the centre window only",
    ["app/[locale]/(center)/sessions/page.tsx", "app/[locale]/(center)/expenses/page.tsx", "app/[locale]/(center)/audit/page.tsx"].every((file) => {
      const source = readFileSync(file, "utf8");
      return /visibilityWindowFloor\(ctx/.test(source) && !/teacherVisibilityWindowFloor/.test(source);
    }),
  );
  check(
    "Static: the floor the scoped helpers inject is the centre window",
    /return visibilityWindowFloor\(ctx, now\);/.test(readFileSync("lib/db/visibility.ts", "utf8").split("export function centreReadFloor")[1] ?? ""),
  );
  check(
    "Static: no file reads the deprecated dataVisibilityDays except the branch-copy carry-over (backlog: drop it)",
    listTs("app").concat(listTs("lib")).every((file) => {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      const uses = source.match(/\bdataVisibilityDays\b/g)?.length ?? 0;
      return uses === 0 || (file.endsWith("lib/db/branches.ts") && uses === 2);
    }),
  );

  // Caps refused server-side — the schemas the actions parse with.
  const general = (centre: string, teacher: string) =>
    generalSettingsSchema.safeParse({
      locale: "en",
      defaultShareType: "PERCENTAGE",
      shareValue: "15",
      defaultLateThreshold: "10",
      timezone: "Africa/Cairo",
      centerDataVisibilityDays: centre,
      teacherDataVisibilityDays: teacher,
    });
  const admin = (centre: string, teacher: string) =>
    centerVisibilityWindowSchema.safeParse({ locale: "en", id: center.id, centerDataVisibilityDays: centre, teacherDataVisibilityDays: teacher });
  check(
    "Caps: Settings → General accepts 365/30 and refuses 366, 31 and 0 (server-side, not only the form's max)",
    MAX_CENTER_VISIBILITY_DAYS === 365 &&
      MAX_TEACHER_VISIBILITY_DAYS === 30 &&
      general("365", "30").success &&
      !general("366", "30").success &&
      !general("365", "31").success &&
      !general("0", "30").success &&
      !general("365", "0").success,
  );
  check(
    "Caps: the platform admin's override is held to the same caps",
    admin("365", "30").success && !admin("366", "30").success && !admin("365", "31").success && !admin("1.5", "30").success,
  );
  check(
    "Caps: a missing field means that field's default (365 / 30)",
    general("", "").data?.centerDataVisibilityDays === 365 && general("", "").data?.teacherDataVisibilityDays === 30,
  );

  // The teacher portal: unlimited at 0, limited when set, never a centre window.
  check(
    "Teacher portal: 0 means all history (no floor)",
    teacherHistoryFloor(0, "Africa/Cairo", NOW) === null,
  );
  check(
    "Teacher portal: a set preference floors at that many days back from the branch's today",
    (teacherHistoryFloor(10, "Africa/Cairo", NOW) as Date).getTime() === startOfUtcDay(NOW).getTime() - 10 * 86_400_000,
  );
  check(
    "Teacher portal: the preference is the only input — the branch's windows do not change it",
    teacherPortalHistoryFloor({ user: { teacherHistoryDays: 0 }, settings: windows(1, 1) }, NOW) === null,
  );
  const fresh = await prisma.user.findUniqueOrThrow({ where: { id: teacherUser.id } });
  const allIds = await teacherStudentProfileIds(prisma, center.id, teacherUser.id, teacherPortalHistoryFloor({ user: fresh, settings: windows(1, 1) }, NOW));
  const limitedIds = await teacherStudentProfileIds(
    prisma,
    center.id,
    teacherUser.id,
    teacherPortalHistoryFloor({ user: { teacherHistoryDays: 1 }, settings: windows(365, 30) }, NOW),
  );
  check(
    "Teacher portal: a new account defaults to all history, and a 1-day preference hides a student last taught 5 days ago",
    fresh.teacherHistoryDays === 0 && allIds.includes(student.id) && !limitedIds.includes(student.id),
    JSON.stringify({ default: fresh.teacherHistoryDays, all: allIds.length, limited: limitedIds.length }),
  );
  check(
    "Teacher portal: the preference accepts All or 1–3650 days and refuses anything else (server-side)",
    MAX_TEACHER_HISTORY_DAYS === 3650 &&
      teacherHistorySchema.safeParse({ locale: "en", historyMode: "all" }).data?.teacherHistoryDays === 0 &&
      teacherHistorySchema.safeParse({ locale: "en", historyMode: "days", historyDays: "3650" }).data?.teacherHistoryDays === 3650 &&
      !teacherHistorySchema.safeParse({ locale: "en", historyMode: "days", historyDays: "3651" }).success &&
      !teacherHistorySchema.safeParse({ locale: "en", historyMode: "days", historyDays: "0" }).success &&
      !teacherHistorySchema.safeParse({ locale: "en", historyMode: "days" }).success,
  );
  check(
    "Static: no teacher-portal file applies a centre window",
    listTs("app/[locale]/(teacher)").concat(listTs("app/[locale]/(print)/teacher")).every(
      (file) => !/visibilityWindowFloor|centreReadFloor/.test(readFileSync(file, "utf8")),
    ),
  );

  // Backfill: the migration copies today's window into both fields, clamped to each cap.
  const migrationDir = readdirSync("prisma/migrations").find((name) => name.endsWith("_u6_split_visibility_windows"));
  const migration = migrationDir ? readFileSync(join("prisma/migrations", migrationDir, "migration.sql"), "utf8") : "";
  check(
    "Backfill: the U6 migration sets each field from dataVisibilityDays, clamped to 1–365 and 1–30",
    /"centerDataVisibilityDays"\s*=\s*LEAST\(GREATEST\("dataVisibilityDays", 1\), 365\)/.test(migration) &&
      /"teacherDataVisibilityDays"\s*=\s*LEAST\(GREATEST\("dataVisibilityDays", 1\), 30\)/.test(migration) &&
      !/DROP COLUMN/.test(migration),
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
