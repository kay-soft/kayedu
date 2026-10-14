/**
 * Analytics & Expenses check — the M6 acceptance gate (docs/03-build-order.md
 * M6 "Done when": "analytics numbers reconcile exactly with the underlying
 * payment snapshots for any date range, and a receptionist cannot reach
 * profit by UI or URL").
 *
 * Run with:  npm run check:analytics
 *
 * Exercises the real production functions — `lib/db/analytics.ts` (the same
 * module `/dashboard` and `/analytics` both call, docs/02 §14) and
 * `lib/db/payments.ts`/`lib/db/attendance.ts` — against two throwaway
 * centers. Needs a reachable database and cleans up after itself.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { scopedData, scopedFindById, scopedWhere } from "../lib/db/tenant-scope.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import {
  attendanceStatusCounts,
  expenseTotals,
  revenueByTeacher,
  revenueTotals,
  studentCounts,
  teacherCounts,
} from "../lib/db/analytics.ts";
import { can } from "../lib/auth/permissions.ts";

const prisma = await gatePrisma();

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

const SLUG_A = "analytics-check-a";
const SLUG_B = "analytics-check-b";

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
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "analytics-check-" } } });
  // Global catalog rows (M13) don't cascade away with the centers above.
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: "Analytics-Check" } } });
  await prisma.catalogGrade.deleteMany({ where: { nameEn: { startsWith: "Analytics-Check" } } });
}

async function makeTeacher(centerId: string, email: string, createdAt: Date) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: email, email, locale: "en", createdAt },
  });
  const membership = await prisma.membership.create({
    data: scopedData(centerId, {
      userId: user.id,
      role: "TEACHER",
      firstName: "T",
      lastName: email,
      email,
      joinedAt: createdAt,
      createdAt,
    }),
  });
  return { user, membership };
}

async function makeStudent(centerId: string, code: string, createdAt: Date) {
  const user = await prisma.user.create({
    data: { firstName: "S", lastName: code, locale: "en", createdAt },
  });
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, {
      userId: user.id,
      studentCode: code,
      firstName: "S",
      lastName: code,
      createdAt,
    }),
  });
  return { user, profile };
}

async function makeSession(
  centerId: string,
  classGroupId: string,
  teacherId: string,
  priceSnapshot: number,
  date: Date,
) {
  return prisma.session.create({
    data: scopedData(centerId, {
      classGroupId,
      teacherId,
      date,
      startTime: "16:00",
      endTime: "18:00",
      priceSnapshot,
    }),
  });
}

async function payFor(
  centerId: string,
  sessionId: string,
  studentProfileId: string,
  actorId: string,
) {
  const attendee = await createAttendance(prisma, {
    centerId,
    sessionId,
    studentProfileId,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: actorId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const methodId = await fixtureMethodId(centerId);
  const result = await prisma.$transaction((tx) =>
    recordPayment(tx, centerId, attendee.id, methodId, actorId, { historicalBackfill: true }),
  );
  if (!result.ok) throw new Error(`recordPayment failed: ${result.error}`);
  return result.payment;
}

const IN_RANGE_FROM = new Date("2026-02-01T00:00:00Z");
const IN_RANGE_TO = new Date("2026-02-28T00:00:00Z");
const BEFORE_RANGE = new Date("2026-01-15T00:00:00Z");
const IN_RANGE_1 = new Date("2026-02-05T00:00:00Z");
const IN_RANGE_2 = new Date("2026-02-20T00:00:00Z");
const AFTER_RANGE = new Date("2026-03-05T00:00:00Z");
const PRICE = 12_000; // 120 EGP

async function main() {
  await cleanup();

  console.log("Permission map (no database needed)");
  check(
    "RECEPTIONIST cannot view analytics.center.view — no path to /analytics at all",
    !can("RECEPTIONIST", "analytics.center.view"),
  );
  check(
    "RECEPTIONIST cannot view center.profit.view by default (no grants)",
    !can("RECEPTIONIST", "center.profit.view"),
  );
  check(
    "RECEPTIONIST cannot manage expenses — no path to /expenses at all",
    !can("RECEPTIONIST", "expense.manage"),
  );
  check(
    "A centre CAN now grant RECEPTIONIST analytics.center.view via the matrix (M12 opens this beyond the old narrow allowlist)",
    can("RECEPTIONIST", "analytics.center.view", { "analytics.center.view": true }),
  );
  check(
    "OWNER can view analytics and expenses (seeded baseline grants)",
    can("OWNER", "analytics.center.view", { "analytics.center.view": true }) &&
      can("OWNER", "expense.manage", { "expense.manage": true }),
  );

  console.log("\nDatabase-backed checks");

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Analytics A", organization: { create: { name: "Analytics A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Analytics B", organization: { create: { name: "Analytics B" } } },
  });

  const { user: teacher1, membership: membership1 } = await makeTeacher(
    centerA.id,
    "analytics-check-teacher-1@kayedu.test",
    BEFORE_RANGE,
  );
  const { user: teacher2 } = await makeTeacher(
    centerA.id,
    "analytics-check-teacher-2@kayedu.test",
    IN_RANGE_1, // "new" within the Feb range
  );
  // An inactive teacher — proves teacherCounts.active differs from .total.
  const { membership: inactiveMembership } = await makeTeacher(
    centerA.id,
    "analytics-check-teacher-3@kayedu.test",
    BEFORE_RANGE,
  );
  await prisma.membership.update({ where: { id: inactiveMembership.id }, data: { active: false } });

  const actorId = teacher1.id;
  // Global catalog rows (M13) — no centerId; ClassGroup references them directly.
  const subjectA = await prisma.catalogSubject.create({
    data: { nameAr: "Analytics-Check Math", nameEn: "Analytics-Check Math" },
  });
  const gradeA = await prisma.catalogGrade.create({
    data: { nameAr: "Analytics-Check Grade 10", nameEn: "Analytics-Check Grade 10" },
  });

  const class1 = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId: teacher1.id,
      subjectId: subjectA.id,
      gradeId: gradeA.id,
      price: PRICE,
      centerShareType: "FIXED",
      centerShareValue: 1_500, // 15 EGP
    }),
  });
  const class2 = await prisma.classGroup.create({
    data: scopedData(centerA.id, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId: teacher2.id,
      subjectId: subjectA.id,
      gradeId: gradeA.id,
      price: PRICE,
      centerShareType: "PERCENTAGE",
      centerShareValue: 15,
    }),
  });

  const studentInRange = await makeStudent(centerA.id, "AN001", IN_RANGE_1);
  const studentBefore = await makeStudent(centerA.id, "AN002", BEFORE_RANGE);

  // ── Payments: two for teacher1 inside the range, one for teacher2 inside,
  // one for teacher1 before the range, one after — only the in-range ones
  // for the queried window should ever be summed.
  const sessionT1InRange1 = await makeSession(centerA.id, class1.id, teacher1.id, PRICE, IN_RANGE_1);
  const paymentT1a = await payFor(centerA.id, sessionT1InRange1.id, studentInRange.profile.id, actorId);

  const sessionT1InRange2 = await makeSession(centerA.id, class1.id, teacher1.id, PRICE, IN_RANGE_2);
  const paymentT1b = await payFor(centerA.id, sessionT1InRange2.id, studentBefore.profile.id, actorId);

  const sessionT2InRange = await makeSession(centerA.id, class2.id, teacher2.id, PRICE, IN_RANGE_1);
  const paymentT2 = await payFor(centerA.id, sessionT2InRange.id, studentInRange.profile.id, actorId);

  const sessionBeforeRange = await makeSession(centerA.id, class1.id, teacher1.id, PRICE, BEFORE_RANGE);
  await payFor(centerA.id, sessionBeforeRange.id, studentBefore.profile.id, actorId);

  const sessionAfterRange = await makeSession(centerA.id, class1.id, teacher1.id, PRICE, AFTER_RANGE);
  await payFor(centerA.id, sessionAfterRange.id, studentInRange.profile.id, actorId);

  check(
    "Every recorded payment carries the session's teacherId snapshot",
    paymentT1a.teacherId === teacher1.id && paymentT2.teacherId === teacher2.id,
  );

  // ── Expenses: one in range, one before it.
  const category = await prisma.expenseCategory.create({
    data: scopedData(centerA.id, { name: "Rent" }),
  });
  await prisma.expense.create({
    data: scopedData(centerA.id, {
      categoryId: category.id,
      amount: 5_000_00, // 5,000 EGP
      date: IN_RANGE_1,
      recordedBy: actorId,
    }),
  });
  await prisma.expense.create({
    data: scopedData(centerA.id, {
      categoryId: category.id,
      amount: 1_000_00,
      date: BEFORE_RANGE,
      recordedBy: actorId,
    }),
  });

  const range = { from: IN_RANGE_FROM, to: IN_RANGE_TO };

  // ── 1. Revenue totals reconcile exactly with the in-range payments ───────
  const expectedCollected = paymentT1a.amount + paymentT1b.amount + paymentT2.amount;
  const expectedCenterShare =
    paymentT1a.centerShareSnapshot + paymentT1b.centerShareSnapshot + paymentT2.centerShareSnapshot;
  const totals = await revenueTotals(prisma, centerA.id, range);
  check(
    "revenueTotals sums exactly the 3 in-range payments — not the out-of-range ones",
    totals.collected === expectedCollected &&
      totals.centerShare === expectedCenterShare &&
      totals.paymentCount === 3,
    JSON.stringify({ totals, expectedCollected, expectedCenterShare }),
  );

  const totalsAllTime = await revenueTotals(prisma, centerA.id, { from: null, to: null });
  check(
    "revenueTotals with null bounds ('all time') includes every payment, in and out of range",
    totalsAllTime.paymentCount === 5,
    `got ${totalsAllTime.paymentCount}`,
  );

  const totalsForTeacher2 = await revenueTotals(prisma, centerA.id, range, teacher2.id);
  check(
    "revenueTotals narrows to one teacher when teacherId is passed",
    totalsForTeacher2.paymentCount === 1 && totalsForTeacher2.collected === paymentT2.amount,
    JSON.stringify(totalsForTeacher2),
  );

  // ── 2. By-teacher breakdown reconciles per teacher ───────────────────────
  const byTeacher = await revenueByTeacher(prisma, centerA.id, range);
  const t1Row = byTeacher.find((row) => row.teacherId === teacher1.id);
  const t2Row = byTeacher.find((row) => row.teacherId === teacher2.id);
  check(
    "revenueByTeacher groups teacher1's 2 in-range payments correctly",
    t1Row?.paymentCount === 2 && t1Row.collected === paymentT1a.amount + paymentT1b.amount,
    JSON.stringify(t1Row),
  );
  check(
    "revenueByTeacher groups teacher2's 1 in-range payment correctly",
    t2Row?.paymentCount === 1 && t2Row.collected === paymentT2.amount,
    JSON.stringify(t2Row),
  );

  // ── 3. Expenses reconcile, and feed the net figure ───────────────────────
  const expTotals = await expenseTotals(prisma, centerA.id, range);
  check(
    "expenseTotals sums only the in-range expense",
    expTotals.total === 5_000_00 && expTotals.count === 1,
    JSON.stringify(expTotals),
  );
  const net = totals.centerShare - expTotals.total;
  check(
    "Analytics' net figure is centerShare minus expenses for the same range",
    net === expectedCenterShare - 5_000_00,
    `net=${net}`,
  );

  // ── 4. Attendance status counts (Dashboard "today"-style summary) ───────
  const statusCounts = await attendanceStatusCounts(prisma, centerA.id, range);
  check(
    "attendanceStatusCounts counts every PRESENT attendee in range (3 paid attendees)",
    statusCounts.PRESENT === 3,
    JSON.stringify(statusCounts),
  );

  // ── 5. User counts: total/active/new ─────────────────────────────────────
  const sCounts = await studentCounts(prisma, centerA.id, range);
  check(
    "studentCounts: 2 active students total, 1 new within the range",
    sCounts.total === 2 && sCounts.new === 1,
    JSON.stringify(sCounts),
  );
  const tCounts = await teacherCounts(prisma, centerA.id, range);
  check(
    "teacherCounts: 3 total, 2 active (one deactivated), 1 new within the range",
    tCounts.total === 3 && tCounts.active === 2 && tCounts.new === 1,
    JSON.stringify(tCounts),
  );

  // ── 6. Cross-center isolation ────────────────────────────────────────────
  const centerBTotals = await revenueTotals(prisma, centerB.id, { from: null, to: null });
  check(
    "Center B's revenueTotals sees none of Center A's payments",
    centerBTotals.paymentCount === 0 && centerBTotals.collected === 0,
    JSON.stringify(centerBTotals),
  );
  const centerBExpenses = await expenseTotals(prisma, centerB.id, { from: null, to: null });
  check(
    "Center B's expenseTotals sees none of Center A's expenses",
    centerBExpenses.total === 0 && centerBExpenses.count === 0,
  );
  const centerBByTeacher = await revenueByTeacher(prisma, centerB.id, { from: null, to: null });
  check("Center B's revenueByTeacher is empty", centerBByTeacher.length === 0);
  check(
    "Center B cannot resolve Center A's ExpenseCategory by id",
    (await scopedFindById(prisma.expenseCategory, centerB.id, category.id)) === null,
  );
  const expenseInA = await prisma.expense.findFirstOrThrow({
    where: scopedWhere(centerA.id, { categoryId: category.id, date: IN_RANGE_1 }),
  });
  check(
    "Center B cannot resolve Center A's Expense by id",
    (await scopedFindById(prisma.expense, centerB.id, expenseInA.id)) === null,
  );
  check(
    "Center A's membership id does not resolve for a Center B TenantContext-style lookup",
    (await scopedFindById(prisma.membership, centerB.id, membership1.id)) === null,
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
      console.error(`\n${failures} analytics check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll analytics checks passed.");
  });
