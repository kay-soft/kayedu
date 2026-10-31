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
 * U5 replaced F1's owner self-serve (decided 29 Oct with Kamal, OD-12
 * re-decided): §4 now asserts no centre role can create a branch — by UI or
 * by direct call — while a platform admin can, within the limit, with Copy
 * setup; §5 the admin's edit and pause (preview, the cancelled and untouched
 * sessions, the refusals while paused, ending early); §6 delete (each
 * refusal, absence from every resolution and count) and restore.
 *
 * Needs a reachable database and cleans up after itself.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { gatePrisma } from "./lib/gate-db.ts";
import { deleteAuditRows } from "./lib/audit-maintenance.ts";
import { PICK_BRANCH, requireBranchScope } from "../lib/auth/branch-scope.ts";
import { PERMISSIONS } from "../lib/auth/permissions.ts";
import { resolveCenterRelations } from "../lib/auth/relations.ts";
import { BRANCH_COPY_KEYS, MAX_PAUSE_DAYS, RESTORE_WINDOW_DAYS } from "../lib/branch-setup.ts";
import { addDays, dateKey, dayMarker, zonedClock } from "../lib/scheduling.ts";
import { resolveSessionRequest } from "../lib/db/approvals.ts";
import {
  createBranchPause,
  deleteBranch,
  endBranchPause,
  platformDeletedBranches,
  previewBranchPause,
  restoreBranch,
  updateBranchDetails,
} from "../lib/db/branch-admin.ts";
import { branchPauseRefusal, currentBranchPause, pausedUntilFrom } from "../lib/db/branch-pauses.ts";
import { createManualSession } from "../lib/db/class-sessions.ts";
import { discoverCenter } from "../lib/db/discover.ts";
import { activeChildLinks } from "../lib/db/parents.ts";
import { loadPermissionGrants } from "../lib/db/permissions.ts";
import {
  addBranchToOrganization,
  listAccessibleCenters,
  lockOrganizationBranches,
  platformCenterList,
  platformOrganizationList,
  updateOrganizationBranchLimit,
  type AddBranchInput,
  type AddBranchResult,
} from "../lib/db/platform.ts";
import { centerBaselineGaps, hasFullBaseline, provisionCenterBaseline } from "../lib/db/provision.ts";
import { publicBranchBySlug } from "../lib/db/public-catalog.ts";
import { validateReceptionSession } from "../lib/db/reception.ts";
import { SessionClosedError } from "../lib/db/session-lifecycle.ts";
import { rescheduleSession } from "../lib/db/sessions.ts";
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
// U5 (was F1's owner self-serve): the admin's Add to an existing
// organization. Every branch it creates is named and slugged from this prefix.
const F1_PREFIX = "branches-check-f1";
const F1_ORG_X = "Branches Check F1 Org X";
const F1_ORG_Y = "Branches Check F1 Org Y";
// U5 pause / delete fixtures — their organizations, cleaned up with F1's.
const U5_ORG_NAMES = ["Branches Check U5 Org", "Branches Check U5 Org D", "Branches Check U5 Solo"];

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
    where: { name: { in: [F1_ORG_X, F1_ORG_Y, ...U5_ORG_NAMES] } },
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

  await checkRollupRefusesBranchWork(organization.id, branchIds);

  await checkAdminAddBranch();
  await checkEditAndPause();
  await checkDeleteAndRestore();
}

// ── 3b. T6: roll-up mode refuses a write and reads nothing ───────────────────
//
// A roll-up context still holds one representative branch, so a centre
// action that skipped the guard would write there. Every centre action calls
// `requireBranchScope(ctx)` straight after `getTenantContext("center")` —
// `check:design` asserts each call site statically. This pass asserts the
// guard's answer for the real organization, and that an action shaped that
// way (guard → read → write, the docs/02 §7 order) touches no row at either
// branch under a roll-up, while the same action at a branch does write.
async function checkRollupRefusesBranchWork(organizationId: string, branchIds: string[]) {
  const rollupCtx = { rollupOrganizationId: organizationId, centerId: branchIds[0] };
  const branchCtx = { rollupOrganizationId: null, centerId: branchIds[0] };
  check(
    "requireBranchScope answers pickBranch for the organization's roll-up, nothing for a branch",
    requireBranchScope(rollupCtx) === PICK_BRANCH && requireBranchScope(branchCtx) === null,
  );

  let reads = 0;
  async function guardedExpenseAction(ctx: typeof rollupCtx | typeof branchCtx) {
    if (requireBranchScope(ctx)) return PICK_BRANCH;
    reads += 1;
    await prisma.expense.count({ where: { centerId: ctx.centerId } });
    await prisma.expense.create({
      data: scopedData(ctx.centerId, { amount: 1_00, date: new Date("2026-02-03T00:00:00Z"), recordedBy: "t6" }),
    });
    return { status: "saved" as const };
  }

  const countAt = () =>
    Promise.all(branchIds.map((id) => prisma.expense.count({ where: { centerId: id } })));
  const before = await countAt();
  const refused = await guardedExpenseAction(rollupCtx);
  const afterRefusal = await countAt();
  check(
    "Under a roll-up the action returns pickBranch, reads nothing and writes no row at any branch",
    refused === PICK_BRANCH && reads === 0 && JSON.stringify(before) === JSON.stringify(afterRefusal),
    JSON.stringify({ refused, reads, before, afterRefusal }),
  );

  const saved = await guardedExpenseAction(branchCtx);
  const afterBranch = await countAt();
  check(
    "At a picked branch the same action writes there and only there",
    "status" in saved && afterBranch[0] === before[0] + 1 && afterBranch[1] === before[1],
    JSON.stringify({ before, afterBranch }),
  );
  await prisma.expense.deleteMany({ where: { centerId: branchIds[0], recordedBy: "t6" } });
}

// ── 4. U5: only a platform admin creates a branch (replaces F1's owner self-serve) ──

/** Every file under a directory, recursively (static checks). */
function filesUnder(dir: string): string[] {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute).flatMap((entry) => {
    const full = join(absolute, entry);
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    return statSync(full).isDirectory() ? filesUnder(rel) : /\.tsx?$/.test(entry) ? [rel] : [];
  });
}

async function checkAdminAddBranch() {
  console.log("\nU5 — no centre role creates a branch; a platform admin does, within the limit");

  // ── The centre side has nothing: no permission, no screen, no action ──
  check(
    "organization.branch.create is gone from the permission catalogue — no role, Owner included, can hold it",
    !(PERMISSIONS as readonly string[]).includes("organization.branch.create") &&
      !PERMISSIONS.some((permission) => permission.startsWith("organization.")),
  );
  check(
    "Settings → Branches does not exist (no page, no actions) and the settings sub-nav has no Branches item (static)",
    !existsSync(join(ROOT, "app", "[locale]", "(center)", "settings", "branches")) &&
      !/branches/i.test(readFileSync(join(ROOT, "app", "[locale]", "(center)", "settings", "layout.tsx"), "utf8").replace(/\/\/.*$/gm, "")),
  );
  const branchWriters = /addBranchToOrganization|provisionBranch|createCenterWithSettings|lib\/db\/branch-admin|admin\/centers\/branch-actions|updateBranchDetails|createBranchPause|endBranchPause|deleteBranch|restoreBranch/;
  const centreFiles = ["(center)", "(teacher)", "(student)", "(parent)", "(auth)", "(public)", "(print)"].flatMap((group) =>
    filesUnder(`app/[locale]/${group}`),
  );
  const reaching = centreFiles.filter((file) => branchWriters.test(readFileSync(join(ROOT, file), "utf8")));
  check(
    "No centre, teacher, student, parent, auth or public file can call a branch create/edit/pause/delete/restore (static)",
    centreFiles.length > 0 && reaching.length === 0,
    reaching.join(", "),
  );
  const adminActions = readFileSync(join(ROOT, "app", "[locale]", "(admin)", "admin", "centers", "branch-actions.ts"), "utf8");
  const exported = [...adminActions.matchAll(/export async function (\w+)\([\s\S]*?\{\n([\s\S]*?)\n\}/g)];
  check(
    "Every branch-management action is platform-admin only: requirePlatformAdmin() is its first statement (static)",
    exported.length === 5 &&
      exported.every((match) => /^\s*const admin = await requirePlatformAdmin\(\);/.test(match[2])),
    exported.map((match) => match[1]).join(", "),
  );
  const centerActions = readFileSync(join(ROOT, "app", "[locale]", "(admin)", "admin", "centers", "actions.ts"), "utf8");
  check(
    "The admin's create (new or existing organization) starts with requirePlatformAdmin() (static)",
    /export async function createCenterAction\([\s\S]*?\{\s*const admin = await requirePlatformAdmin\(\);/.test(centerActions),
  );

  // ── The admin's "Add to an existing organization", with Copy setup ──
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

  const ownerX = await prisma.user.create({
    data: { firstName: "F1", lastName: "owner-x", email: "branches-check-f1-owner-x@kayedu.test", locale: "en" },
  });
  await prisma.membership.create({ data: scopedData(home.id, { userId: ownerX.id, role: "OWNER", joinedAt: new Date() }) });

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
      centerDataVisibilityDays: 120,
      teacherDataVisibilityDays: 12,
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

  let slugCounter = 0;
  const input = (overrides: Partial<AddBranchInput> = {}): AddBranchInput => {
    slugCounter += 1;
    return {
      organizationId: orgX.id,
      name: `${F1_PREFIX} new ${slugCounter}`,
      nameEn: `${F1_PREFIX} new ${slugCounter}`,
      slug: `${F1_PREFIX}-new-${slugCounter}`,
      themeColor: "#7C3AED",
      copyFrom: { centerId: home.id, keys: BRANCH_COPY_KEYS },
      ...overrides,
    };
  };
  const branchCount = (organizationId: string) =>
    prisma.center.count({ where: { organizationId, deletedAt: null } });

  // Another customer's branch is never a copy source, nor a deleted one.
  const copyAbroad = await addBranchToOrganization(prisma, input({ copyFrom: { centerId: foreign.id, keys: BRANCH_COPY_KEYS } }));
  check(
    "Copy setup from another customer's branch is refused (sourceNotFound), and nothing is created",
    !copyAbroad.ok && copyAbroad.error === "sourceNotFound" && (await branchCount(orgX.id)) === 2,
    JSON.stringify(copyAbroad),
  );
  const softDeleted = { deletedAt: new Date(), restorableUntil: new Date(Date.now() + 86_400_000) };
  await prisma.center.update({ where: { id: sibling.id }, data: softDeleted });
  const copyDeleted = await addBranchToOrganization(prisma, input({ copyFrom: { centerId: sibling.id, keys: BRANCH_COPY_KEYS } }));
  await prisma.center.update({ where: { id: sibling.id }, data: { deletedAt: null, restorableUntil: null } });
  check(
    "…nor from a deleted branch of the same organization",
    !copyDeleted.ok && copyDeleted.error === "sourceNotFound",
    JSON.stringify(copyDeleted),
  );

  // Two concurrent adds at limit-1: exactly one succeeds (the organization row lock).
  const otherDesk = await gatePrisma({ sweepUsers: false });
  let raced: AddBranchResult[] = [];
  try {
    raced = await Promise.all([
      addBranchToOrganization(prisma, input()),
      addBranchToOrganization(otherDesk, input()),
    ]);
  } finally {
    await otherDesk.$disconnect();
  }
  const winners = raced.filter((result) => result.ok);
  const losers = raced.filter((result) => !result.ok);
  check(
    "Two concurrent admin adds at limit-1: exactly one succeeds, the other is refused branchLimitReached",
    winners.length === 1 &&
      losers.length === 1 &&
      !losers[0].ok &&
      losers[0].error === "branchLimitReached" &&
      (await branchCount(orgX.id)) === 3,
    JSON.stringify(raced.map((result) => (result.ok ? "ok" : result.error))),
  );
  const atLimit = await addBranchToOrganization(prisma, input());
  check(
    "At the limit, the admin's add is refused branchLimitReached",
    !atLimit.ok && atLimit.error === "branchLimitReached" && (await branchCount(orgX.id)) === 3,
  );

  const created = winners[0]?.ok ? winners[0] : null;
  if (!created) throw new Error("U5: no branch was created by the race — cannot check the copy.");
  check(
    "The new branch joins the organization ONBOARDING and reports every ticked part as copied",
    created.center.organizationId === orgX.id &&
      created.center.lifecycleState === "ONBOARDING" &&
      created.copied.join(",") === BRANCH_COPY_KEYS.join(","),
  );
  const relations = await resolveCenterRelations(prisma, ownerX.id);
  check(
    "The new branch resolves for the organization's Owner at once — what the switcher and /select-center list",
    relations.some((relation) => relation.center.id === created.center.id && relation.roles.includes("OWNER")),
  );

  // What was ticked is copied…
  const [selections, methods, terms, holidays, receptionGrants, settings] = await Promise.all([
    prisma.centerCatalogSelection.findMany({ where: { centerId: created.center.id } }),
    prisma.centerPaymentMethod.findMany({ where: { centerId: created.center.id }, select: { name: true } }),
    prisma.centerTerm.findMany({ where: { centerId: created.center.id } }),
    prisma.holiday.findMany({ where: { centerId: created.center.id } }),
    loadPermissionGrants(prisma, created.center.id, "RECEPTIONIST"),
    prisma.centerSettings.findUnique({ where: { centerId: created.center.id } }),
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
      hasFullBaseline(await centerBaselineGaps(prisma, created.center.id)),
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
  check(
    "U6: both data-visibility windows are copied with the general settings",
    settings?.centerDataVisibilityDays === 120 && settings.teacherDataVisibilityDays === 12,
    JSON.stringify(settings),
  );

  // …and nothing else ever is.
  const never = await Promise.all([
    prisma.room.count({ where: { centerId: created.center.id } }),
    prisma.classGroup.count({ where: { centerId: created.center.id } }),
    prisma.session.count({ where: { centerId: created.center.id } }),
    prisma.membership.count({ where: { centerId: created.center.id } }),
    prisma.studentProfile.count({ where: { centerId: created.center.id } }),
    prisma.invitation.count({ where: { centerId: created.center.id } }),
    prisma.payment.count({ where: { centerId: created.center.id } }),
    prisma.expense.count({ where: { centerId: created.center.id } }),
    prisma.expenseCategory.count({ where: { centerId: created.center.id } }),
    prisma.settlement.count({ where: { centerId: created.center.id } }),
    prisma.refund.count({ where: { centerId: created.center.id } }),
  ]);
  check(
    "Copy never copies rooms, classes, sessions, people (staff, teachers, students, invitations) or money",
    never.every((count) => count === 0),
    never.join(","),
  );
  const createdRow = await prisma.center.findUniqueOrThrow({ where: { id: created.center.id } });
  check("…nor the ID-card layout or the logo", settings?.cardLayout === null && createdRow.logoPath === null);

  // Nothing ticked: the provisioning baseline only. The admin raises the limit first.
  const raised = await updateOrganizationBranchLimit(prisma, { organizationId: orgX.id, maxBranches: 4, actorUserId: ownerX.id });
  const bare = await addBranchToOrganization(prisma, input({ copyFrom: null }));
  const bareCenter = bare.ok ? bare.center : null;
  const bareGrants = bareCenter ? await loadPermissionGrants(prisma, bareCenter.id, "RECEPTIONIST") : {};
  const bareSettings = bareCenter ? await prisma.centerSettings.findUnique({ where: { centerId: bareCenter.id } }) : null;
  check(
    "With no copy source, the branch gets the baseline only: default methods, no picks/terms/holidays, baseline grants and settings",
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

  // An archived branch stops counting, and so does a deleted one: the slot comes back.
  const usedNow = async () => {
    const lock = await prisma.$transaction((tx) => lockOrganizationBranches(tx, orgX.id));
    return lock?.used ?? -1;
  };
  const usedBefore = await usedNow();
  await prisma.center.update({ where: { id: sibling.id }, data: { lifecycleState: "ARCHIVED" } });
  const usedAfterArchive = await usedNow();
  check(
    "Archived branches do not count toward the limit",
    usedBefore === 4 && usedAfterArchive === 3,
    JSON.stringify({ usedBefore, usedAfterArchive }),
  );

  // Static: there is one provisioning path.
  const platformSource = readFileSync(join(ROOT, "lib", "db", "platform.ts"), "utf8");
  check(
    "addBranchToOrganization creates through provisionBranch and copies through copyBranchSetup on the same transaction (static)",
    /export async function addBranchToOrganization[\s\S]*?await provisionBranch\(tx,[\s\S]*?copyBranchSetup\(tx,/.test(platformSource) &&
      !/\.center\.create\(/.test(readFileSync(join(ROOT, "lib", "db", "branches.ts"), "utf8")),
  );
}

// ── 5. U5: edit and pause ─────────────────────────────────────────────────────

const U5_ORG = "Branches Check U5 Org";
const U5_ORG_SOLO = "Branches Check U5 Solo";
const U5_PREFIX = "branches-check-u5";

async function makeU5Branch(organizationId: string, tag: string) {
  const center = await prisma.center.create({
    data: { slug: `${U5_PREFIX}-${tag}`, name: `${U5_PREFIX} ${tag}`, organizationId, lifecycleState: "ACTIVE" },
  });
  await prisma.$transaction((tx) => provisionCenterBaseline(tx, center.id));
  return center;
}

async function makeU5Class(centerId: string, teacherId: string, roomId: string | null) {
  return prisma.classGroup.create({
    data: scopedData(centerId, {
      startDate: new Date("2026-01-01"),
      endDate: new Date("2027-12-31"),
      teacherId,
      roomId,
      price: 10_000,
      centerShareType: "PERCENTAGE",
      centerShareValue: 15,
    }),
  });
}

async function makeU5Session(
  centerId: string,
  classGroupId: string,
  teacherId: string,
  date: Date,
  startTime: string,
  endTime: string,
  extra: { roomId?: string | null; closedAt?: Date; status?: "SCHEDULED" | "COMPLETED" } = {},
) {
  return prisma.session.create({
    data: scopedData(centerId, {
      classGroupId,
      teacherId,
      roomId: extra.roomId ?? null,
      date,
      startTime,
      endTime,
      priceSnapshot: 10_000,
      status: extra.status ?? "SCHEDULED",
      closedAt: extra.closedAt ?? null,
      closeMode: extra.closedAt ? "MANUAL" : null,
    }),
  });
}

async function checkEditAndPause() {
  console.log("\nU5 — edit and pause a branch (platform admin)");
  const org = await prisma.organization.create({ data: { name: U5_ORG, maxBranches: 10 } });
  const branch = await makeU5Branch(org.id, "pause");
  const admin = await prisma.user.create({
    data: { firstName: "U5", lastName: "admin", email: "branches-check-u5-admin@kayedu.test", locale: "en", isPlatformAdmin: true },
  });

  // ── Edit: names and colour; never the slug or the timezone ──
  const edited = await updateBranchDetails(prisma, {
    centerId: branch.id,
    name: `${U5_PREFIX} renamed`,
    nameEn: "U5 renamed",
    themeColor: "#16A34A",
    actorUserId: admin.id,
  });
  const editAudit = await prisma.auditLog.findFirst({ where: { action: "platform.branch.update", entityId: branch.id } });
  check(
    "Edit changes the names and theme colour; the slug and the timezone stay",
    edited.ok &&
      edited.center.name === `${U5_PREFIX} renamed` &&
      edited.center.nameEn === "U5 renamed" &&
      edited.center.themeColor === "#16A34A" &&
      edited.center.slug === branch.slug &&
      (await prisma.centerSettings.findUnique({ where: { centerId: branch.id } }))?.timezone === "Africa/Cairo",
  );
  check(
    "Edit is audited platform.branch.update with the changed fields only — no name in the row",
    editAudit?.actorUserId === admin.id &&
      JSON.stringify(editAudit.after) === JSON.stringify({ changed: ["nameAr", "nameEn", "themeColor"] }),
    JSON.stringify(editAudit?.after),
  );

  // ── Fixtures: a class with sessions around and inside the range ──
  const now = new Date();
  const todayKey = zonedClock(now, "Africa/Cairo").dayKey;
  const day = (offset: number) => addDays(dayMarker(todayKey), offset);
  const teacher = await makeTeacher(branch.id, "branches-check-u5-teacher@kayedu.test");
  const room = await prisma.room.create({ data: scopedData(branch.id, { name: "U5 room", capacity: 30 }) });
  const classOne = await makeU5Class(branch.id, teacher.id, room.id);
  const classTwo = await makeU5Class(branch.id, teacher.id, room.id);
  const live = await makeU5Session(branch.id, classOne.id, teacher.id, day(0), "00:00", "23:59", { roomId: room.id });
  const closed = await makeU5Session(branch.id, classOne.id, teacher.id, day(0), "00:05", "00:06", {
    roomId: room.id,
    status: "COMPLETED",
    closedAt: now,
  });
  const s1 = await makeU5Session(branch.id, classOne.id, teacher.id, day(2), "16:00", "18:00", { roomId: room.id });
  const s2 = await makeU5Session(branch.id, classOne.id, teacher.id, day(3), "16:00", "18:00", { roomId: room.id });
  const s3 = await makeU5Session(branch.id, classOne.id, teacher.id, day(4), "16:00", "18:00", { roomId: room.id });
  const paid = await makeU5Session(branch.id, classOne.id, teacher.id, day(5), "16:00", "18:00", { roomId: room.id });
  const after = await makeU5Session(branch.id, classOne.id, teacher.id, day(20), "16:00", "18:00", { roomId: room.id });

  const enrolled = await makeStudent(branch.id, "U5-ENROLLED");
  const enrollment = await prisma.enrollment.create({
    data: scopedData(branch.id, { classGroupId: classOne.id, studentProfileId: enrolled.profile.id, status: "ACTIVE" }),
  });
  const booker = await prisma.user.create({ data: { firstName: "B", lastName: "u5", email: "branches-check-u5-booker@kayedu.test", locale: "en" } });
  const booking = await prisma.sessionBooking.create({
    data: scopedData(branch.id, { sessionId: s1.id, studentId: booker.id, status: "CONFIRMED" }),
  });
  const payer = await makeStudent(branch.id, "U5-PAYER");
  const payerAttendee = await createAttendance(
    prisma,
    { centerId: branch.id, sessionId: paid.id, studentProfileId: payer.profile.id, enrollmentId: null, isDropIn: true, recordedBy: teacher.id },
    { historicalBackfill: true, status: "PRESENT" },
  );
  const methodId = await fixtureMethodId(branch.id);
  const payment = await prisma.$transaction((tx) =>
    recordPayment(tx, branch.id, payerAttendee.id, methodId, teacher.id, { historicalBackfill: true }),
  );
  if (!payment.ok) throw new Error(`U5 payment fixture failed: ${JSON.stringify(payment)}`);

  const range = { centerId: branch.id, startDate: todayKey, endDate: dateKey(day(10)) };

  // ── The range rules ──
  const pastStart = await previewBranchPause(prisma, { ...range, startDate: dateKey(day(-1)) });
  const endBefore = await previewBranchPause(prisma, { ...range, endDate: dateKey(day(-1)) });
  const tooLong = await previewBranchPause(prisma, { ...range, endDate: dateKey(day(MAX_PAUSE_DAYS)) });
  const longest = await previewBranchPause(prisma, { ...range, endDate: dateKey(day(MAX_PAUSE_DAYS - 1)) });
  check(
    "A pause starts no earlier than the branch's today, ends on or after its start, and spans at most 90 days",
    !pastStart.ok && pastStart.error === "pauseStartPast" &&
      !endBefore.ok && endBefore.error === "pauseEndBeforeStart" &&
      !tooLong.ok && tooLong.error === "pauseTooLong" &&
      longest.ok,
    JSON.stringify([pastStart, endBefore, tooLong].map((result) => (result.ok ? "ok" : result.error))),
  );

  // ── Preview: the numbers, nothing written ──
  const preview = await previewBranchPause(prisma, range);
  check(
    "The preview counts 3 sessions, 1 class, 1 booking and 1 kept with a payment — and writes nothing",
    preview.ok &&
      preview.impact.sessions === 3 &&
      preview.impact.classes === 1 &&
      preview.impact.bookings === 1 &&
      preview.impact.keptWithPayments === 1 &&
      (await prisma.branchPause.count({ where: { centerId: branch.id } })) === 0 &&
      (await prisma.session.count({ where: { centerId: branch.id, status: "CANCELLED" } })) === 0,
    JSON.stringify(preview),
  );

  // ── Create: cancels exactly the scheduled, not-yet-started sessions in range ──
  const created = await createBranchPause(prisma, { ...range, reason: "Renovation", actorUserId: admin.id }, now);
  if (!created.ok) throw new Error(`U5: the pause was refused: ${JSON.stringify(created)}`);
  const read = (id: string) => prisma.session.findUniqueOrThrow({ where: { id } });
  const [r1, r2, r3, rLive, rClosed, rPaid, rAfter] = await Promise.all([s1, s2, s3, live, closed, paid, after].map((row) => read(row.id)));
  check(
    "Creating the pause cancels the in-range scheduled sessions through cancelSession and tags each with pauseId",
    [r1, r2, r3].every((row) => row.status === "CANCELLED" && row.pauseId === created.pause.id) &&
      created.impact.sessions === 3 &&
      created.impact.bookings === 1 &&
      created.impact.keptWithPayments === 1,
    JSON.stringify(created.impact),
  );
  check(
    "Started (live), closed, paid and out-of-range sessions are untouched",
    rLive.status === "SCHEDULED" && rLive.pauseId === null &&
      rClosed.status === "COMPLETED" && rClosed.pauseId === null &&
      rPaid.status === "SCHEDULED" && rPaid.pauseId === null &&
      rAfter.status === "SCHEDULED" && rAfter.pauseId === null,
  );
  const bookingAfter = await prisma.sessionBooking.findUniqueOrThrow({ where: { id: booking.id } });
  check(
    "The cancelled session's open booking is cancelled with it, as F6 does (SESSION_CANCELLED)",
    bookingAfter.status === "CANCELLED" && bookingAfter.cancelReason === "SESSION_CANCELLED",
  );
  check(
    "Enrolments are untouched",
    (await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status === "ACTIVE",
  );
  const pauseAudit = await prisma.auditLog.findFirst({ where: { action: "platform.branch.pause", entityId: created.pause.id } });
  check(
    "The pause is audited platform.branch.pause on the branch, ids and counts only (the reason stays on the pause)",
    pauseAudit?.centerId === branch.id &&
      pauseAudit.actorUserId === admin.id &&
      !JSON.stringify(pauseAudit.after).includes("Renovation") &&
      created.pause.reason === "Renovation",
    JSON.stringify(pauseAudit?.after),
  );
  const second = await createBranchPause(prisma, { ...range, startDate: dateKey(day(30)), endDate: dateKey(day(31)), reason: null, actorUserId: admin.id });
  check(
    "At most one current or future pause per branch (pauseExists)",
    !second.ok && second.error === "pauseExists",
    JSON.stringify(second),
  );

  // ── While the pause covers today ──
  const current = await currentBranchPause(prisma, branch.id, now);
  check("currentBranchPause names it — the shell banner's and Discover's source", current?.id === created.pause.id);
  let checkInRefusal = "";
  const walkIn = await makeStudent(branch.id, "U5-WALKIN");
  try {
    await createAttendance(prisma, {
      centerId: branch.id,
      sessionId: live.id,
      studentProfileId: walkIn.profile.id,
      enrollmentId: null,
      isDropIn: true,
      recordedBy: teacher.id,
    });
  } catch (error) {
    checkInRefusal = error instanceof SessionClosedError ? error.reason : String(error);
  }
  const desk = await validateReceptionSession(prisma, { centerId: branch.id, sessionId: live.id, timeZone: "Africa/Cairo", now });
  check(
    "Check-in is refused while paused — the attendance writer (branchPaused) and the desk's session check",
    checkInRefusal === "branchPaused" && !desk.ok && desk.reason === "branchPaused" &&
      (await prisma.sessionAttendee.count({ where: { sessionId: live.id } })) === 0,
    JSON.stringify({ checkInRefusal, desk }),
  );
  const extra = await createManualSession(
    prisma,
    branch.id,
    { classGroupId: classOne.id, teacherId: teacher.id, roomId: room.id, extraRoomIds: [], date: day(40), startTime: "10:00", endTime: "11:00" },
    { confirmConflicts: false, now },
  );
  check(
    "An extra session is refused while paused, even dated after the pause (branchPaused)",
    !extra.ok && extra.error === "branchPaused",
    JSON.stringify(extra),
  );
  const moved = await rescheduleSession(prisma, branch.id, after.id, { date: day(6), startTime: "10:00", endTime: "11:00" }, "WARN", "en", { confirmConflicts: false, now });
  check(
    "A reschedule into the pause is refused (branchPaused)",
    !moved.ok && moved.error === "branchPaused",
    JSON.stringify(moved),
  );
  const request = await prisma.changeRequest.create({
    data: scopedData(branch.id, {
      type: "NEW_SESSION",
      requestedBy: teacher.id,
      payload: { classGroupId: classOne.id, date: dateKey(day(7)), startTime: "10:00", endTime: "11:00" },
    }),
  });
  const approved = await resolveSessionRequest(prisma, branch.id, request.id, "APPROVED", admin.id, "WARN", "en", { confirmConflicts: false, now });
  check(
    "A teacher session request into the pause is refused at the request and at approval (branchPaused)",
    !approved.ok && approved.error === "branchPaused" &&
      (await branchPauseRefusal(prisma, branch.id, { date: day(7), now })) === "branchPaused" &&
      (await branchPauseRefusal(prisma, branch.id, { date: day(25), now })) === null,
    JSON.stringify(approved),
  );
  const teacherActions = readFileSync(join(ROOT, "app", "[locale]", "(teacher)", "teacher", "sessions", "actions.ts"), "utf8");
  check(
    "The teacher's request action asks branchPauseRefusal for its date before writing (static)",
    /branchPauseRefusal\(prisma, ctx\.center\.id, \{ date: dayMarker\(date\) \}\)[\s\S]*db\.changeRequests\.create/.test(teacherActions),
  );
  check(
    "Enrolment stays possible: no reservation or enrolment path asks about pauses (static)",
    !/branch-pauses|branchPauseRefusal/.test(readFileSync(join(ROOT, "lib", "db", "reservations.ts"), "utf8")) &&
      (await discoverCenter(prisma, branch.id)) !== null,
  );
  check(
    "pausedUntilFrom (Explore) names the end of the pause covering today, and nothing outside it",
    pausedUntilFrom([{ startDate: day(0), endDate: day(10) }], todayKey)?.getTime() === day(10).getTime() &&
      pausedUntilFrom([{ startDate: day(1), endDate: day(10) }], todayKey) === null,
  );

  // ── End pause now: untouched tagged sessions still ahead come back ──
  await new Promise((resolve) => setTimeout(resolve, 20));
  await prisma.session.update({ where: { id: s3.id }, data: { description: "touched since the pause" } });
  const clash = await makeU5Session(branch.id, classTwo.id, teacher.id, day(3), "16:30", "17:30");
  const ended = await endBranchPause(prisma, { centerId: branch.id, pauseId: created.pause.id, actorUserId: admin.id });
  const [e1, e2, e3] = await Promise.all([s1, s2, s3].map((row) => read(row.id)));
  check(
    "End pause now restores the untouched session, keeps the one that now clashes and the one changed since",
    ended.ok && ended.restored === 1 && ended.keptConflicts === 1 && ended.keptOther === 1 &&
      e1.status === "SCHEDULED" && e1.pauseId === null &&
      e2.status === "CANCELLED" && e2.pauseId === created.pause.id &&
      e3.status === "CANCELLED",
    JSON.stringify(ended),
  );
  check(
    "Bookings are not restored",
    (await prisma.sessionBooking.findUniqueOrThrow({ where: { id: booking.id } })).status === "CANCELLED",
  );
  const endedRow = await prisma.branchPause.findUniqueOrThrow({ where: { id: created.pause.id } });
  check(
    "The pause records who ended it, check-in works again, and a second end is refused (pauseOver)",
    endedRow.endedEarlyAt !== null && endedRow.endedEarlyBy === admin.id &&
      (await currentBranchPause(prisma, branch.id)) === null &&
      (await validateReceptionSession(prisma, { centerId: branch.id, sessionId: live.id, timeZone: "Africa/Cairo", now: new Date() })).ok &&
      !(await endBranchPause(prisma, { centerId: branch.id, pauseId: created.pause.id, actorUserId: admin.id })).ok,
  );
  check(
    "Ending is audited platform.branch.pause.end with the counts",
    (await prisma.auditLog.count({ where: { action: "platform.branch.pause.end", entityId: created.pause.id } })) === 1,
  );
  await prisma.session.delete({ where: { id: clash.id } });
}

// ── 6. U5: delete and restore ──────────────────────────────────────────────────

async function checkDeleteAndRestore() {
  console.log("\nU5 — delete (soft) and restore a branch (platform admin)");
  const org = await prisma.organization.create({ data: { name: `${U5_ORG} D`, maxBranches: 4 } });
  const solo = await prisma.organization.create({ data: { name: U5_ORG_SOLO, maxBranches: 1 } });
  const main = await makeU5Branch(org.id, "d-main");
  const target = await makeU5Branch(org.id, "d-target");
  const busy = await makeU5Branch(org.id, "d-live");
  const owing = await makeU5Branch(org.id, "d-settlement");
  const only = await makeU5Branch(solo.id, "d-only");
  const admin = await prisma.user.findFirstOrThrow({ where: { email: "branches-check-u5-admin@kayedu.test" } });

  // People who reach the target branch, one way each.
  const person = (tag: string) =>
    prisma.user.create({ data: { firstName: "U5", lastName: tag, email: `branches-check-u5-${tag}@kayedu.test`, locale: "en" } });
  const owner = await person("owner");
  await prisma.membership.create({ data: scopedData(main.id, { userId: owner.id, role: "OWNER", joinedAt: new Date() }) });
  const onlyThere = await person("manager-only-there");
  await prisma.membership.create({ data: scopedData(target.id, { userId: onlyThere.id, role: "MANAGER", joinedAt: new Date() }) });
  const granted = await person("manager-granted");
  const grantedMembership = await prisma.membership.create({
    data: scopedData(main.id, { userId: granted.id, role: "MANAGER", joinedAt: new Date() }),
  });
  await prisma.membershipBranchGrant.create({
    data: { membershipId: grantedMembership.id, centerId: target.id, grantedBy: owner.id },
  });
  const child = await person("child");
  await prisma.studentProfile.create({
    data: scopedData(target.id, { userId: child.id, studentCode: "U5-CHILD", firstName: "C", lastName: "u5" }),
  });
  const parent = await person("parent");
  await prisma.familyLink.create({ data: { parentUserId: parent.id, studentUserId: child.id, source: "LEGACY_VERIFIED" } });
  await prisma.centerSettings.update({ where: { centerId: target.id }, data: { publicListing: true } });

  // Blockers on their own branches.
  const teacherBusy = await makeTeacher(busy.id, "branches-check-u5-busy-teacher@kayedu.test");
  const busyClass = await makeU5Class(busy.id, teacherBusy.id, null);
  const todayBusy = dayMarker(zonedClock(new Date(), "Africa/Cairo").dayKey);
  await makeU5Session(busy.id, busyClass.id, teacherBusy.id, todayBusy, "00:00", "23:59");
  const teacherOwing = await makeTeacher(owing.id, "branches-check-u5-owing-teacher@kayedu.test");
  await prisma.settlement.create({
    data: scopedData(owing.id, { teacherId: teacherOwing.id, totalAmount: 0, createdBy: owner.id }),
  });

  const del = (centerId: string, confirmName: string) => deleteBranch(prisma, { centerId, confirmName, actorUserId: admin.id });
  const refusedOnly = await del(only.id, only.name);
  const refusedLive = await del(busy.id, busy.name);
  const refusedSettlement = await del(owing.id, owing.name);
  const refusedName = await del(target.id, "not the name");
  check(
    "Delete is refused for the organization's only branch, a branch with a live session, one with a DRAFT/APPROVED settlement, and a mistyped name",
    !refusedOnly.ok && refusedOnly.error === "onlyBranch" &&
      !refusedLive.ok && refusedLive.error === "liveSession" &&
      !refusedSettlement.ok && refusedSettlement.error === "openSettlement" &&
      !refusedName.ok && refusedName.error === "nameMismatch" &&
      (await prisma.center.count({ where: { id: { in: [only.id, busy.id, owing.id, target.id] }, deletedAt: { not: null } } })) === 0,
    JSON.stringify([refusedOnly, refusedLive, refusedSettlement, refusedName].map((result) => (result.ok ? "ok" : result.error))),
  );

  // Present everywhere before…
  const visible = async () => {
    const [ownerRelations, onlyRelations, grantedRelations, rollup, accessible, children, publicRow, adminList, orgList] = await Promise.all([
      resolveCenterRelations(prisma, owner.id),
      resolveCenterRelations(prisma, onlyThere.id),
      resolveCenterRelations(prisma, granted.id),
      organizationBranches(prisma, org.id),
      listAccessibleCenters(prisma),
      activeChildLinks(prisma, parent.id),
      publicBranchBySlug(prisma, target.slug),
      platformCenterList(prisma, org.id),
      platformOrganizationList(prisma),
    ]);
    const lock = await prisma.$transaction((tx) => lockOrganizationBranches(tx, org.id));
    return {
      owner: ownerRelations.some((relation) => relation.center.id === target.id),
      onlyThere: onlyRelations.length,
      granted: grantedRelations.some((relation) => relation.center.id === target.id),
      rollup: rollup.some((branch) => branch.id === target.id),
      directory: accessible.some((center) => center.id === target.id),
      discover: (await discoverCenter(prisma, target.id)) !== null,
      parent: children.some((link) => link.studentUser.studentProfiles.some((profile) => profile.centerId === target.id)),
      explore: publicRow !== null,
      adminList: adminList.some((row) => row.id === target.id),
      orgUsed: orgList.find((row) => row.id === org.id)?.usedBranches ?? -1,
      limitUsed: lock?.used ?? -1,
    };
  };
  const before = await visible();
  check(
    "Before the delete, the branch resolves, lists and counts everywhere",
    before.owner && before.onlyThere === 1 && before.granted && before.rollup && before.directory && before.discover &&
      before.parent && before.explore && before.adminList && before.orgUsed === 4 && before.limitUsed === 4,
    JSON.stringify(before),
  );

  const deleted = await del(target.id, `  ${target.name} `);
  const deletedRow = await prisma.center.findUniqueOrThrow({ where: { id: target.id } });
  const afterDelete = await visible();
  check(
    "Delete is soft: deletedAt, deletedBy and restorableUntil (+30 days); nothing else is removed",
    deleted.ok &&
      deletedRow.deletedAt !== null &&
      deletedRow.deletedBy === admin.id &&
      Math.round((deletedRow.restorableUntil!.getTime() - deletedRow.deletedAt.getTime()) / 86_400_000) === RESTORE_WINDOW_DAYS &&
      deletedRow.lifecycleState === "ACTIVE" &&
      (await prisma.studentProfile.count({ where: { centerId: target.id } })) === 1 &&
      (await prisma.membership.count({ where: { centerId: target.id } })) === 1,
  );
  check(
    "A deleted branch is absent from every resolution and count: Owner widening, its only member (→ hub empty state), branch grants, analytics roll-up, directories, Discover, the parent portal, Explore, the admin list and the branch limit",
    !afterDelete.owner && afterDelete.onlyThere === 0 && !afterDelete.granted && !afterDelete.rollup &&
      !afterDelete.directory && !afterDelete.discover && !afterDelete.parent && !afterDelete.explore &&
      !afterDelete.adminList && afterDelete.orgUsed === 3 && afterDelete.limitUsed === 3,
    JSON.stringify(afterDelete),
  );
  check(
    "It is listed on its organization's admin page as deleted, and the delete is audited platform.branch.delete",
    (await platformDeletedBranches(prisma, org.id)).some((row) => row.id === target.id) &&
      (await prisma.auditLog.count({ where: { action: "platform.branch.delete", entityId: target.id, actorUserId: admin.id } })) === 1,
  );

  // Restore: within the window and the limit.
  const restored = await restoreBranch(prisma, { centerId: target.id, actorUserId: admin.id });
  const afterRestore = await visible();
  check(
    "Restore within the window brings it back everywhere, and is audited platform.branch.restore",
    restored.ok && afterRestore.owner && afterRestore.onlyThere === 1 && afterRestore.explore && afterRestore.limitUsed === 4 &&
      (await prisma.auditLog.count({ where: { action: "platform.branch.restore", entityId: target.id } })) === 1,
    JSON.stringify(afterRestore),
  );
  const notDeleted = await restoreBranch(prisma, { centerId: target.id, actorUserId: admin.id });
  check("Restoring a branch that isn't deleted is refused (notDeleted)", !notDeleted.ok && notDeleted.error === "notDeleted");

  // The slot it freed was taken meanwhile: restore is refused at the limit.
  const again = await del(target.id, target.name);
  await updateOrganizationBranchLimit(prisma, { organizationId: org.id, maxBranches: 3, actorUserId: admin.id });
  const full = await restoreBranch(prisma, { centerId: target.id, actorUserId: admin.id });
  check(
    "Restore is refused while the branch limit is full (branchLimitReached)",
    again.ok && !full.ok && full.error === "branchLimitReached",
    JSON.stringify(full),
  );
  await updateOrganizationBranchLimit(prisma, { organizationId: org.id, maxBranches: 4, actorUserId: admin.id });
  await prisma.center.update({ where: { id: target.id }, data: { restorableUntil: new Date(Date.now() - 1_000) } });
  const expired = await restoreBranch(prisma, { centerId: target.id, actorUserId: admin.id });
  check(
    "After restorableUntil, restore is refused (restoreExpired) — the row is still in the database",
    !expired.ok && expired.error === "restoreExpired" && (await prisma.center.count({ where: { id: target.id } })) === 1,
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
