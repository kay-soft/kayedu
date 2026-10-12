/**
 * Branch restructure check — the M11 acceptance gate
 * (docs/03-build-order.md M11 "Gates"):
 * "an organization with two branches shows an all-branches roll-up that
 *  equals exactly the sum of the two branches' own figures, and a user
 *  scoped to Branch A cannot read a Branch B record by URL or by direct
 *  API/action call."
 *
 * Run with:  npm run check:branches
 *
 * Two parts, mirroring the isolation gate's own split between a pure
 * primitive and a database-backed pass:
 *
 *  1. Roll-up reconciliation — seeds real Payment rows (via the same
 *     `createAttendance`/`recordPayment` production functions every other
 *     money gate uses) at two branches under one Organization, then asserts
 *     `revenueTotalsRollup`/`expenseTotalsRollup`/`studentCountsRollup`/
 *     `teacherCountsRollup` (lib/db/organizations.ts) equal *exactly* the sum
 *     of each branch's own `lib/db/analytics.ts` totals — never a query
 *     spanning both centerIds in the database (docs/01-data-model.md §4).
 *  2. Branch-A-cannot-read-branch-B by id, on one non-money model (Room) and
 *     one money-bearing model (Payment) — the same `scopedFindById` shape
 *     `npm run check:isolation` already proves, asserted again here because
 *     this milestone is the one claiming `centerId`-scoping is unchanged by
 *     the organization layer (docs/02-architecture.md §4).
 *
 * It also asserts the primitive the M11 Owner-widening logic in
 * `lib/auth/tenant.ts`'s `getUserCenterRelations` is built on
 * (`organizationBranches`, lib/db/organizations.ts) resolves every active
 * branch under an organization — `getUserCenterRelations` itself is not
 * imported here because it pulls in Next-runtime modules
 * (next-intl/server, next/headers via lib/auth/active-center.ts), which every
 * gate script in this codebase deliberately avoids (docs/02-architecture.md
 * §5) in favor of testing the underlying pure/database condition directly.
 *
 * Needs a reachable database and cleans up after itself.
 */
import { PrismaClient } from "@prisma/client";
import {
  requireScopedById,
  scopedData,
  scopedFindById,
} from "../lib/db/tenant-scope.ts";
import { createAttendance } from "../lib/db/attendance.ts";
import { recordPayment } from "../lib/db/payments.ts";
import {
  ensureDefaultPaymentMethods,
  listActivePaymentMethods,
} from "../lib/db/payment-methods.ts";
import { expenseTotals, revenueTotals, studentCounts, teacherCounts } from "../lib/db/analytics.ts";
import {
  expenseTotalsRollup,
  organizationBranches,
  revenueTotalsRollup,
  studentCountsRollup,
  teacherCountsRollup,
} from "../lib/db/organizations.ts";

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

const SLUG_A = "branches-check-a";
const SLUG_B = "branches-check-b";
const ORG_NAME = "Branches Check Org";

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
  await prisma.organization.deleteMany({ where: { name: ORG_NAME } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "branches-check-" } } });
  // A global catalog row (M13) doesn't cascade away with the centers above.
  await prisma.catalogSubject.deleteMany({ where: { nameEn: { startsWith: "Branches-Check" } } });
}

async function makeTeacher(centerId: string, email: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: email, email, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerId, {
      userId: user.id,
      role: "TEACHER",
      firstName: "T",
      lastName: email,
      email,
      joinedAt: new Date(),
    }),
  });
  return user;
}

async function makeStudent(centerId: string, code: string) {
  const user = await prisma.user.create({ data: { firstName: "S", lastName: code, locale: "en" } });
  const profile = await prisma.studentProfile.create({
    data: scopedData(centerId, { userId: user.id, studentCode: code, firstName: "S", lastName: code }),
  });
  return { user, profile };
}

/** Seeds one real, snapshotted payment at a branch — the money a roll-up sums. */
async function seedPayment(centerId: string, teacherId: string, amount: number) {
  // A global catalog row (M13) — no centerId.
  const subject = await prisma.catalogSubject.create({
    data: { nameAr: "Branches-Check Math", nameEn: "Branches-Check Math" },
  });
  const classGroup = await prisma.classGroup.create({
    data: scopedData(centerId, {
      startDate: new Date("2026-01-01"), endDate: new Date("2027-12-31"), // R4 fixture shape: a class period is required
      teacherId,
      subjectId: subject.id,
      price: amount,
      centerShareType: "PERCENTAGE",
      centerShareValue: 15,
    }),
  });
  const session = await prisma.session.create({
    data: scopedData(centerId, {
      classGroupId: classGroup.id,
      teacherId,
      date: new Date("2026-02-02T00:00:00Z"),
      startTime: "16:00",
      endTime: "18:00",
      priceSnapshot: amount,
    }),
  });
  const student = await makeStudent(centerId, `BR-${centerId.slice(0, 6)}`);
  const attendee = await createAttendance(prisma, {
    centerId,
    sessionId: session.id,
    studentProfileId: student.profile.id,
    enrollmentId: null,
    isDropIn: true,
    recordedBy: teacherId,
  }, { historicalBackfill: true, status: "PRESENT" });
  const methodId = await fixtureMethodId(centerId);
  const result = await prisma.$transaction((tx) =>
    recordPayment(tx, centerId, attendee.id, methodId, teacherId, { historicalBackfill: true }),
  );
  if (!result.ok) throw new Error(`seedPayment failed: ${JSON.stringify(result)}`);
  return result.payment;
}

async function main() {
  await cleanup();

  const organization = await prisma.organization.create({ data: { name: ORG_NAME } });
  const branchA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Branches Check A", organizationId: organization.id },
  });
  const branchB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Branches Check B", organizationId: organization.id },
  });

  const teacherA = await makeTeacher(branchA.id, "branches-check-teacher-a@kayedu.test");
  const teacherB = await makeTeacher(branchB.id, "branches-check-teacher-b@kayedu.test");

  console.log("Branch restructure check");

  // ── 1. The org-widening primitive resolves every branch under the org ───
  const resolvedBranches = await organizationBranches(prisma, organization.id);
  check(
    "organizationBranches resolves both branches under one organization",
    resolvedBranches.length === 2 &&
      resolvedBranches.some((b) => b.id === branchA.id) &&
      resolvedBranches.some((b) => b.id === branchB.id),
    JSON.stringify(resolvedBranches),
  );

  // ── 2. Roll-up reconciliation — never a query spanning both centerIds ───
  const paymentA = await seedPayment(branchA.id, teacherA.id, 12_000); // 120 EGP
  const paymentB = await seedPayment(branchB.id, teacherB.id, 20_000); // 200 EGP
  await prisma.expense.create({
    data: scopedData(branchA.id, { amount: 5_000, date: new Date("2026-02-02T00:00:00Z"), recordedBy: "seed" }),
  });
  await prisma.expense.create({
    data: scopedData(branchB.id, { amount: 3_000, date: new Date("2026-02-02T00:00:00Z"), recordedBy: "seed" }),
  });

  const range = { from: new Date("2026-02-01T00:00:00Z"), to: new Date("2026-02-28T00:00:00Z") };
  const branchIds = [branchA.id, branchB.id];

  const [revenueA, revenueB, revenueRollup] = await Promise.all([
    revenueTotals(prisma, branchA.id, range),
    revenueTotals(prisma, branchB.id, range),
    revenueTotalsRollup(prisma, branchIds, range),
  ]);
  check(
    "Revenue roll-up (collected) equals exactly the sum of both branches",
    revenueRollup.collected === revenueA.collected + revenueB.collected &&
      revenueRollup.collected === 32_000,
    JSON.stringify({ revenueA, revenueB, revenueRollup }),
  );
  check(
    "Revenue roll-up (center share) equals exactly the sum of both branches",
    revenueRollup.centerShare === revenueA.centerShare + revenueB.centerShare,
  );
  check(
    "Revenue roll-up (payment count) equals exactly the sum of both branches",
    revenueRollup.paymentCount === revenueA.paymentCount + revenueB.paymentCount &&
      revenueRollup.paymentCount === 2,
  );

  const [expenseA, expenseB, expenseRollup] = await Promise.all([
    expenseTotals(prisma, branchA.id, range),
    expenseTotals(prisma, branchB.id, range),
    expenseTotalsRollup(prisma, branchIds, range),
  ]);
  check(
    "Expense roll-up equals exactly the sum of both branches",
    expenseRollup.total === expenseA.total + expenseB.total && expenseRollup.total === 8_000,
  );

  const [studentsA, studentsB, studentsRollup] = await Promise.all([
    studentCounts(prisma, branchA.id, range),
    studentCounts(prisma, branchB.id, range),
    studentCountsRollup(prisma, branchIds, range),
  ]);
  check(
    "Student-count roll-up equals exactly the sum of both branches",
    studentsRollup.total === studentsA.total + studentsB.total,
  );

  const [teachersA, teachersB, teachersRollup] = await Promise.all([
    teacherCounts(prisma, branchA.id, range),
    teacherCounts(prisma, branchB.id, range),
    teacherCountsRollup(prisma, branchIds, range),
  ]);
  check(
    "Teacher-count roll-up equals exactly the sum of both branches",
    teachersRollup.total === teachersA.total + teachersB.total,
  );

  // ── 3. Branch A cannot read Branch B by id — a non-money model and a
  //      money-bearing one, the exact shape `check:isolation` asserts,
  //      re-proven here because this milestone is what claims centerId
  //      scoping survives the organization layer unchanged. ────────────────
  const roomB = await prisma.room.create({ data: scopedData(branchB.id, { name: "B room" }) });

  const foreignRoom = await scopedFindById(prisma.room, branchA.id, roomB.id);
  check(
    "Branch A cannot read Branch B's Room (non-money) by id",
    foreignRoom === null,
    foreignRoom ? `leaked room ${foreignRoom.id}` : "",
  );

  const foreignPayment = await scopedFindById(prisma.payment, branchA.id, paymentB.id);
  check(
    "Branch A cannot read Branch B's Payment (money-bearing) by id",
    foreignPayment === null,
    foreignPayment ? `leaked payment ${foreignPayment.id}` : "",
  );

  let threwOnForeignPayment = false;
  try {
    await requireScopedById(prisma.payment, branchA.id, paymentB.id, "Payment");
  } catch (error) {
    threwOnForeignPayment = error instanceof Error && error.name === "TenantScopeError";
  }
  check("requireScopedById throws across branches for Payment too", threwOnForeignPayment);

  // Branch A's own rows are unaffected — the roll-up widens *reads across
  // branches an Owner is resolved to*, it never widens what one scoped query
  // returns (docs/02-architecture.md §4).
  const ownPayment = await scopedFindById(prisma.payment, branchA.id, paymentA.id);
  check("Branch A still reads its own Payment by id", ownPayment?.id === paymentA.id);
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
      console.error(`\n${failures} branch restructure check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll branch restructure checks passed.");
  });
