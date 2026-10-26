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
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { PERMISSIONS, can } from "../lib/auth/permissions.ts";
import { resolveCenterRelations } from "../lib/auth/relations.ts";
import { BRANCH_COPY_KEYS } from "../lib/branch-setup.ts";
import { addBranchAsOwner, organizationBranchUsage } from "../lib/db/branches.ts";
import { loadPermissionGrants } from "../lib/db/permissions.ts";
import { updateOrganizationBranchLimit } from "../lib/db/platform.ts";
import { centerBaselineGaps, hasFullBaseline, provisionCenterBaseline } from "../lib/db/provision.ts";
import { addBranchSchema } from "../lib/validation/branches.ts";
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

const prisma = await gatePrisma();
const ROOT = join(import.meta.dirname, "..");

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
// F1: an Owner's Add branch. Every branch it creates is named and slugged
// from this prefix, so cleanup finds them however the slug was picked.
const F1_PREFIX = "branches-check-f1";
const F1_ORG_X = "Branches Check F1 Org X";
const F1_ORG_Y = "Branches Check F1 Org Y";

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
  const f1Orgs = await prisma.organization.findMany({
    where: { name: { in: [F1_ORG_X, F1_ORG_Y] } },
    select: { id: true },
  });
  const f1OrgIds = f1Orgs.map((org) => org.id);
  // The organization-level limit row has no centre to cascade with (F1).
  await deleteAuditRows(prisma, { entityType: "Organization", entityId: { in: f1OrgIds } });
  const f1Centers = await prisma.center.findMany({ where: { organizationId: { in: f1OrgIds } }, select: { id: true } });
  await deleteAuditRows(prisma, { centerId: { in: f1Centers.map((center) => center.id) } });
  await prisma.center.deleteMany({ where: { organizationId: { in: f1OrgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: f1OrgIds } } });
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

  await checkOwnerAddBranch();
}

// ── 4. F1: an Owner's Add branch, within the organization's limit ────────────

async function checkOwnerAddBranch() {
  console.log("\nF1 — Add branch (owner self-serve, OD-12 (b))");

  // Organization X: limit 3, two branches — one slot left. Organization Y:
  // another customer, one branch.
  const orgX = await prisma.organization.create({ data: { name: F1_ORG_X, maxBranches: 3 } });
  const orgY = await prisma.organization.create({ data: { name: F1_ORG_Y, maxBranches: 5 } });
  const make = async (organizationId: string, tag: string, lifecycleState: "ACTIVE" | "ONBOARDING") => {
    const center = await prisma.center.create({
      data: { slug: `${F1_PREFIX}-${tag}`, name: `${F1_PREFIX} ${tag}`, organizationId, lifecycleState },
    });
    await prisma.$transaction((tx) => provisionCenterBaseline(tx, center.id));
    return center;
  };
  const home = await make(orgX.id, "home", "ACTIVE");
  const sibling = await make(orgX.id, "sibling", "ONBOARDING");
  const foreign = await make(orgY.id, "foreign", "ACTIVE");

  const person = async (tag: string) =>
    prisma.user.create({ data: { firstName: "F1", lastName: tag, email: `branches-check-f1-${tag}@kayedu.test`, locale: "en" } });
  const ownerX = await person("owner-x");
  const managerX = await person("manager-x");
  const ownerY = await person("owner-y");
  await prisma.membership.create({ data: scopedData(home.id, { userId: ownerX.id, role: "OWNER", joinedAt: new Date() }) });
  await prisma.membership.create({ data: scopedData(home.id, { userId: managerX.id, role: "MANAGER", joinedAt: new Date() }) });
  await prisma.membership.create({ data: scopedData(foreign.id, { userId: ownerY.id, role: "OWNER", joinedAt: new Date() }) });

  // The home branch's setup — what may be copied, and what never may be.
  const subject = await prisma.catalogSubject.create({ data: { nameAr: "Branches-Check F1", nameEn: "Branches-Check F1" } });
  await prisma.centerCatalogSelection.create({
    data: scopedData(home.id, { kind: "SUBJECT", subjectId: subject.id, displayNameAr: "مادة", displayNameEn: "Our subject" }),
  });
  await prisma.centerPaymentMethod.create({ data: scopedData(home.id, { name: "Branches-Check bank" }) });
  await prisma.centerTerm.create({
    data: scopedData(home.id, { name: "F1 term", startDate: new Date("2026-09-01T00:00:00Z"), endDate: new Date("2027-01-31T00:00:00Z") }),
  });
  await prisma.holiday.create({ data: scopedData(home.id, { date: new Date("2026-12-25T00:00:00Z"), name: "F1 holiday" }) });
  await prisma.permissionGrant.update({
    where: { centerId_role_action: { centerId: home.id, role: "RECEPTIONIST", action: "student.manage" } },
    data: { allowed: false },
  });
  await prisma.permissionGrant.create({ data: scopedData(home.id, { role: "RECEPTIONIST", action: "expense.manage", allowed: true }) });
  await prisma.centerSettings.update({
    where: { centerId: home.id },
    data: {
      defaultShareType: "FIXED",
      defaultShareValue: 2_500,
      defaultLateThreshold: 5,
      scheduleConflictPolicy: "DENY",
      dataVisibilityDays: 45,
      teacherEditDeadlineHours: 12,
      cardLayout: { version: 1, background: "#0f2a1d" },
    },
  });
  await prisma.center.update({ where: { id: home.id }, data: { logoPath: `${home.id}/logo.f1.png` } });
  await prisma.room.create({ data: scopedData(home.id, { name: "F1 room" }) });
  const teacher = await makeTeacher(home.id, "branches-check-f1-teacher@kayedu.test");
  await seedPayment(home.id, teacher.id, 10_000); // a class, a session, a student, a payment
  const category = await prisma.expenseCategory.create({ data: scopedData(home.id, { name: "F1 rent" }) });
  await prisma.expense.create({
    data: scopedData(home.id, { categoryId: category.id, amount: 1_000, date: new Date("2026-02-02T00:00:00Z"), recordedBy: "seed" }),
  });

  const input = (actorUserId: string, overrides: Partial<Parameters<typeof addBranchAsOwner>[1]> = {}) => ({
    actorUserId,
    actingCenterId: home.id,
    copyFromCenterId: home.id,
    name: `${F1_PREFIX} new`,
    nameEn: `${F1_PREFIX} new`,
    themeColor: "#7C3AED",
    timezone: "Asia/Dubai",
    copy: BRANCH_COPY_KEYS,
    ...overrides,
  });
  const branchCount = (organizationId: string) => prisma.center.count({ where: { organizationId } });

  // The ceiling: a non-Owner is refused, by the data layer as by the page.
  const allOpen = Object.fromEntries(PERMISSIONS.map((permission) => [permission, true]));
  check(
    "organization.branch.create is OWNER-only: no stored row grants it to MANAGER/RECEPTIONIST/ACCOUNTANT/TEACHER",
    can("OWNER", "organization.branch.create", {}) &&
      (["MANAGER", "RECEPTIONIST", "ACCOUNTANT", "TEACHER"] as const).every(
        (role) => !can(role, "organization.branch.create", allOpen),
      ),
  );
  const byManager = await addBranchAsOwner(prisma, input(managerX.id));
  check(
    "A MANAGER calling the action directly is refused by the ceiling, and nothing is created",
    !byManager.ok && byManager.error === "forbidden" && (await branchCount(orgX.id)) === 2,
    JSON.stringify(byManager),
  );

  // Another customer's organization can't be reached, by acting or by copying.
  const actingAbroad = await addBranchAsOwner(prisma, input(ownerX.id, { actingCenterId: foreign.id }));
  check(
    "An Owner cannot add a branch to another customer's organization (acting from its branch)",
    !actingAbroad.ok && actingAbroad.error === "forbidden" && (await branchCount(orgY.id)) === 1,
    JSON.stringify(actingAbroad),
  );
  const copyAbroad = await addBranchAsOwner(prisma, input(ownerX.id, { copyFromCenterId: foreign.id }));
  check(
    "…nor copy another customer's branch setup into their own",
    !copyAbroad.ok && copyAbroad.error === "sourceNotFound" && (await branchCount(orgX.id)) === 2,
    JSON.stringify(copyAbroad),
  );
  const ownerYIntoX = await addBranchAsOwner(prisma, input(ownerY.id));
  check(
    "Organization Y's Owner cannot act from organization X's branch",
    !ownerYIntoX.ok && ownerYIntoX.error === "forbidden" && (await branchCount(orgX.id)) === 2,
  );

  // Two concurrent creates at limit-1: exactly one succeeds (the row lock).
  const otherDesk = await gatePrisma({ sweepUsers: false });
  let raced: Awaited<ReturnType<typeof addBranchAsOwner>>[] = [];
  try {
    raced = await Promise.all([
      addBranchAsOwner(prisma, input(ownerX.id, { name: `${F1_PREFIX} race 1`, nameEn: `${F1_PREFIX} race 1` })),
      addBranchAsOwner(otherDesk, input(ownerX.id, { name: `${F1_PREFIX} race 2`, nameEn: `${F1_PREFIX} race 2` })),
    ]);
  } finally {
    await otherDesk.$disconnect();
  }
  const winners = raced.filter((result) => result.ok);
  const losers = raced.filter((result) => !result.ok);
  check(
    "Two concurrent Add branch calls at limit-1: exactly one succeeds, the other is refused branchLimitReached",
    winners.length === 1 &&
      losers.length === 1 &&
      !losers[0].ok &&
      losers[0].error === "branchLimitReached" &&
      (await branchCount(orgX.id)) === 3,
    JSON.stringify(raced.map((result) => (result.ok ? "ok" : result.error))),
  );
  const atLimit = await addBranchAsOwner(prisma, input(ownerX.id));
  check(
    "At the limit, a direct call is refused branchLimitReached",
    !atLimit.ok && atLimit.error === "branchLimitReached" && (await branchCount(orgX.id)) === 3,
  );

  const created = winners[0]?.ok ? winners[0].center : null;
  if (!created) throw new Error("F1: no branch was created by the race — cannot check the copy.");

  check(
    "The new branch is in the Owner's organization, takes the acting branch's lifecycle (ACTIVE), and its timezone",
    created.organizationId === orgX.id &&
      created.lifecycleState === "ACTIVE" &&
      (await prisma.centerSettings.findUnique({ where: { centerId: created.id } }))?.timezone === "Asia/Dubai",
  );
  const relations = await resolveCenterRelations(prisma, ownerX.id);
  check(
    "The new branch resolves for the Owner at once — what the switcher and /select-center list",
    relations.some((relation) => relation.center.id === created.id && relation.roles.includes("OWNER")),
  );

  // What was ticked is copied…
  const [selections, methods, terms, holidays, receptionGrants, settings] = await Promise.all([
    prisma.centerCatalogSelection.findMany({ where: { centerId: created.id } }),
    prisma.centerPaymentMethod.findMany({ where: { centerId: created.id }, select: { name: true } }),
    prisma.centerTerm.findMany({ where: { centerId: created.id } }),
    prisma.holiday.findMany({ where: { centerId: created.id } }),
    loadPermissionGrants(prisma, created.id, "RECEPTIONIST"),
    prisma.centerSettings.findUnique({ where: { centerId: created.id } }),
  ]);
  const sourceMethods = await prisma.centerPaymentMethod.findMany({ where: { centerId: home.id, active: true }, select: { name: true } });
  const names = (rows: { name: string }[]) => rows.map((row) => row.name).sort().join("|");
  check(
    "Catalog picks are copied with the branch's own names",
    selections.length === 1 && selections[0].subjectId === subject.id && selections[0].displayNameEn === "Our subject",
  );
  check("Payment methods are the source's active ones (the defaults replaced)", names(methods) === names(sourceMethods), names(methods));
  check("Terms and holidays are copied", terms.length === 1 && terms[0].name === "F1 term" && holidays.length === 1);
  check(
    "The permission matrix behaves as the source's — a switched-off cell stays off, an extra grant comes along — with no baseline gap",
    receptionGrants["student.manage"] === false &&
      receptionGrants["expense.manage"] === true &&
      hasFullBaseline(await centerBaselineGaps(prisma, created.id)),
  );
  check(
    "General settings are copied (cut, late threshold, conflict policy, window, edit deadline)",
    settings?.defaultShareType === "FIXED" &&
      settings.defaultShareValue === 2_500 &&
      settings.defaultLateThreshold === 5 &&
      settings.scheduleConflictPolicy === "DENY" &&
      settings.dataVisibilityDays === 45 &&
      settings.teacherEditDeadlineHours === 12,
    JSON.stringify(settings),
  );

  // …and nothing else ever is.
  const never = await Promise.all([
    prisma.room.count({ where: { centerId: created.id } }),
    prisma.classGroup.count({ where: { centerId: created.id } }),
    prisma.session.count({ where: { centerId: created.id } }),
    prisma.membership.count({ where: { centerId: created.id } }),
    prisma.studentProfile.count({ where: { centerId: created.id } }),
    prisma.invitation.count({ where: { centerId: created.id } }),
    prisma.payment.count({ where: { centerId: created.id } }),
    prisma.expense.count({ where: { centerId: created.id } }),
    prisma.expenseCategory.count({ where: { centerId: created.id } }),
    prisma.settlement.count({ where: { centerId: created.id } }),
    prisma.refund.count({ where: { centerId: created.id } }),
  ]);
  check(
    "Copy never copies rooms, classes, sessions, people (staff, teachers, students, invitations) or money",
    never.every((count) => count === 0),
    never.join(","),
  );
  const createdRow = await prisma.center.findUniqueOrThrow({ where: { id: created.id } });
  check(
    "…nor the ID-card layout or the logo",
    settings?.cardLayout === null && createdRow.logoPath === null,
  );
  const audit = await prisma.auditLog.findFirst({ where: { action: "organization.branch.create", entityId: created.id } });
  check(
    "organization.branch.create is audited on the new branch, ids only",
    audit?.centerId === created.id &&
      audit.actorUserId === ownerX.id &&
      (audit.after as { organizationId?: string } | null)?.organizationId === orgX.id,
    JSON.stringify(audit),
  );

  // Nothing ticked: the new branch is exactly the provisioning baseline. The
  // admin raises the limit first (audited by lib/db/platform.ts).
  const raised = await updateOrganizationBranchLimit(prisma, { organizationId: orgX.id, maxBranches: 4, actorUserId: ownerX.id });
  const bare = await addBranchAsOwner(prisma, input(ownerX.id, { name: `${F1_PREFIX} bare`, nameEn: `${F1_PREFIX} bare`, copy: [] }));
  const bareCenter = bare.ok ? bare.center : null;
  const bareGrants = bareCenter ? await loadPermissionGrants(prisma, bareCenter.id, "RECEPTIONIST") : {};
  const bareSettings = bareCenter ? await prisma.centerSettings.findUnique({ where: { centerId: bareCenter.id } }) : null;
  check(
    "With nothing ticked, the branch gets the baseline only: default methods, no picks/terms/holidays, baseline grants and settings",
    raised.ok &&
      bareCenter !== null &&
      (await prisma.centerPaymentMethod.count({ where: { centerId: bareCenter.id } })) === 3 &&
      (await prisma.centerCatalogSelection.count({ where: { centerId: bareCenter.id } })) === 0 &&
      (await prisma.centerTerm.count({ where: { centerId: bareCenter.id } })) === 0 &&
      (await prisma.holiday.count({ where: { centerId: bareCenter.id } })) === 0 &&
      bareGrants["student.manage"] === true &&
      bareGrants["expense.manage"] === undefined &&
      bareSettings?.defaultShareType === "PERCENTAGE" &&
      bareSettings.defaultShareValue === 15,
    JSON.stringify(bare.ok ? "ok" : bare),
  );

  // An archived branch stops counting: the slot comes back.
  const usageBefore = await organizationBranchUsage(prisma, orgX.id);
  await prisma.center.update({ where: { id: sibling.id }, data: { lifecycleState: "ARCHIVED" } });
  const usageAfter = await organizationBranchUsage(prisma, orgX.id);
  check(
    "Archived branches are listed but do not count toward the limit",
    usageBefore?.used === 4 && usageAfter?.used === 3 && usageAfter.branches.length === 4 && usageAfter.maxBranches === 4,
    JSON.stringify({ before: usageBefore?.used, after: usageAfter?.used }),
  );

  // The schema: what the dialog posts, shape only.
  const parsed = addBranchSchema.safeParse({
    locale: "en",
    name: "فرع",
    themeColor: "#2563EB",
    timezone: "Africa/Cairo",
    copyFromCenterId: home.id,
    copy_catalog: "on",
    copy_terms: "on",
  });
  check(
    "addBranchSchema turns the ticks into the copy list and refuses an unknown timezone",
    parsed.success &&
      parsed.data.copy.join(",") === "catalog,terms" &&
      !addBranchSchema.safeParse({ locale: "en", name: "x", themeColor: "#2563EB", timezone: "Mars/Base", copyFromCenterId: home.id }).success,
  );

  // Static: there is one provisioning path, and the owner path is on it.
  const branchesSource = readFileSync(join(ROOT, "lib", "db", "branches.ts"), "utf8");
  check(
    "lib/db/branches.ts creates the branch through provisionBranch — no center.create or provisionCenterBaseline of its own (static)",
    /provisionBranch\(/.test(branchesSource) &&
      !/\.center\.create\(/.test(branchesSource) &&
      !/provisionCenterBaseline\(/.test(branchesSource),
  );
  check(
    "The organization id comes from the acting branch, never from the input (static)",
    /const organizationId = acting\.center\.organizationId;/.test(branchesSource) &&
      !/organizationId:\s*string;[\s\S]{0,40}actingCenterId/.test(branchesSource),
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
      console.error(`\n${failures} branch restructure check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll branch restructure checks passed.");
  });
