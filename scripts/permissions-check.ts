/**
 * Permissions engine check — the M12 acceptance gate
 * (docs/03-build-order.md M12 "Gates"): "matrix resolution, deny-by-default,
 * OWNER-only granting, the ceiling, session invalidation, the teacher-detail
 * leak."
 *
 * Run with:  npm run check:permissions
 *
 * `lib/auth/tenant.ts` is not imported here — it pulls in Next-runtime
 * modules (next-intl/server, next/headers via lib/auth/active-center.ts),
 * which every gate script in this codebase deliberately avoids
 * (docs/02-architecture.md §5) in favor of testing the underlying pure/
 * database primitive directly: `lib/auth/permissions.ts`'s `can()` (free of
 * runtime imports) and `lib/db/permissions.ts`'s DB-backed matrix functions
 * (a `PrismaClient` taken as a parameter, same shape as `lib/db/organizations.ts`).
 *
 * Five parts:
 *  1. Deny-by-default — a brand-new center starts with zero `PermissionGrant`
 *     rows, so every action is denied to every role until granted.
 *  2. The grantable ceiling holds even against a bad stored row — a TEACHER
 *     row for `center.profit.view` and a MANAGER row for an ownership action
 *     must not take effect, and OWNER's ownership actions are forced true
 *     with zero reliance on any stored row at all.
 *  3. OWNER-only granting stays enforceable in code, not just by the UI
 *     hiding the button — the ceiling above *is* that enforcement.
 *  4. Session/immediate effect — writing a `PermissionGrant` row or changing
 *     a `Membership.role` and immediately re-reading (no fresh login, no
 *     cache warm-up) already reflects the new value.
 *  5. The teacher-detail leak (security fix 16) — the exact scoped query
 *     `lib/db/scoped.ts`'s `teachers.findById` runs never structurally
 *     includes another center's `Membership` rows for a teacher who has one.
 *
 * Needs a reachable database and cleans up after itself.
 */
import { PrismaClient, type Role } from "@prisma/client";
import { scopedData, scopedWhere } from "../lib/db/tenant-scope.ts";
import { can, isBranchGrantableRole } from "../lib/auth/permissions.ts";
import {
  grantMembershipBranch,
  loadPermissionGrants,
  membershipBranchGrantsFor,
  revokeMembershipBranch,
  savePermissionGrants,
} from "../lib/db/permissions.ts";

const prisma = new PrismaClient();

const SLUG_A = "permissions-check-a";
const SLUG_B = "permissions-check-b";
const ORG_NAME = "Permissions Check Org";

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
  await prisma.user.deleteMany({ where: { email: { startsWith: "permissions-check-" } } });
}

async function makeTeacher(centerId: string, email: string, tag: string) {
  const user = await prisma.user.create({
    data: { firstName: "T", lastName: tag, email, locale: "en" },
  });
  const membership = await prisma.membership.create({
    data: scopedData(centerId, {
      userId: user.id,
      role: "TEACHER" as Role,
      firstName: "T",
      lastName: tag,
      joinedAt: new Date(),
    }),
  });
  return { user, membership };
}

async function main() {
  await cleanup();

  const org = await prisma.organization.create({ data: { name: ORG_NAME } });
  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Permissions Check A", organizationId: org.id },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Permissions Check B", organizationId: org.id },
  });

  console.log("Permissions engine check");

  // ── 1. Deny-by-default ────────────────────────────────────────────────
  // A brand-new center has zero PermissionGrant rows — nothing was seeded by
  // this script, unlike the M12 migration's backfill of *existing* centers.
  const freshGrants = await loadPermissionGrants(prisma, centerA.id, "MANAGER");
  check(
    "A brand-new center starts with zero grant rows",
    Object.keys(freshGrants).length === 0,
  );
  check(
    "An action with no row is denied — even one a real center's MANAGER normally holds",
    !can("MANAGER", "student.promote", freshGrants),
  );
  check(
    "A brand-new action with no row anywhere is denied to every role",
    !can("MANAGER", "expense.manage", freshGrants) &&
      !can("RECEPTIONIST", "expense.manage", {}) &&
      !can("TEACHER", "expense.manage", {}),
  );

  // ── 2 & 3. The grantable ceiling holds even against a bad stored row ────
  // savePermissionGrants() is deliberately mechanical (lib/db/permissions.ts)
  // — the ceiling is enforced by can(), not by the write path — so writing a
  // row a centre should never have been able to grant, then resolving it
  // through can(), is exactly how a stray or malicious row is proven inert.
  await savePermissionGrants(prisma, centerA.id, [
    { role: "TEACHER", action: "center.profit.view", allowed: true },
    { role: "MANAGER", action: "permission.manage", allowed: true },
    { role: "MANAGER", action: "membership.role.assign", allowed: true },
    { role: "MANAGER", action: "student.promote", allowed: true },
  ]);

  const teacherGrants = await loadPermissionGrants(prisma, centerA.id, "TEACHER");
  const managerGrants = await loadPermissionGrants(prisma, centerA.id, "MANAGER");

  check(
    "A stray TEACHER + center.profit.view row does not take effect — the ceiling wins",
    teacherGrants["center.profit.view"] === true && // the row really was written…
      !can("TEACHER", "center.profit.view", teacherGrants), // …but can() still refuses it
  );
  check(
    "A stray MANAGER + permission.manage row does not take effect — ownership actions are OWNER-only",
    managerGrants["permission.manage"] === true &&
      !can("MANAGER", "permission.manage", managerGrants),
  );
  check(
    "A stray MANAGER + membership.role.assign row does not take effect — role-granting is OWNER-only",
    !can("MANAGER", "membership.role.assign", managerGrants),
  );
  check(
    "OWNER holds every ownership action with ZERO stored rows — nothing to strip",
    can("OWNER", "center.ownership.manage", {}) &&
      can("OWNER", "permission.manage", {}) &&
      can("OWNER", "membership.role.assign", {}) &&
      can("OWNER", "membership.branch.grant", {}),
  );
  check(
    "A genuinely grantable action DOES take effect once stored (the matrix is otherwise open, M12)",
    can("MANAGER", "student.promote", managerGrants),
  );
  check(
    "No centre's matrix may ever grant the platform-only action, OWNER included",
    !can("OWNER", "platform.manage", { "platform.manage": true }) &&
      !can("MANAGER", "platform.manage", { "platform.manage": true }),
  );

  // ── 4. Session/immediate effect (security fix 17) ───────────────────────
  // Revoke the stray grant and re-read immediately — no fresh login, no
  // cache warm-up, just the next call — and the new value is already there.
  await savePermissionGrants(prisma, centerA.id, [
    { role: "MANAGER", action: "student.promote", allowed: false },
  ]);
  const managerGrantsAfterRevoke = await loadPermissionGrants(prisma, centerA.id, "MANAGER");
  check(
    "Revoking a grant takes effect on the very next read, not the next login",
    !can("MANAGER", "student.promote", managerGrantsAfterRevoke),
  );

  // A role change: create a MANAGER membership, seed distinct baseline grants
  // for MANAGER and ACCOUNTANT, flip the membership's role, and confirm the
  // very next resolution (re-reading Membership + PermissionGrant fresh, the
  // same thing `getTenantContext()` does every request) already reflects it.
  const person = await prisma.user.create({
    data: { firstName: "P", lastName: "RoleChange", email: "permissions-check-rolechange@kayedu.test", locale: "en" },
  });
  const membership = await prisma.membership.create({
    data: scopedData(centerA.id, { userId: person.id, role: "MANAGER" as Role, joinedAt: new Date() }),
  });
  await savePermissionGrants(prisma, centerA.id, [
    { role: "MANAGER", action: "class.manage", allowed: true },
    { role: "ACCOUNTANT", action: "expense.manage", allowed: true },
  ]);

  const beforeGrants = await loadPermissionGrants(prisma, centerA.id, membership.role);
  const canManageClassesBefore = can(membership.role, "class.manage", beforeGrants);

  await prisma.membership.update({ where: { id: membership.id }, data: { role: "ACCOUNTANT" } });
  const updated = await prisma.membership.findUniqueOrThrow({ where: { id: membership.id } });
  const afterGrants = await loadPermissionGrants(prisma, centerA.id, updated.role);

  check(
    "Before the change: a MANAGER resolves the MANAGER grants",
    canManageClassesBefore && !can("MANAGER", "expense.manage", beforeGrants),
  );
  check(
    "Immediately after the role change: the same membership resolves the NEW role's grants, not the old one's",
    updated.role === "ACCOUNTANT" &&
      can("ACCOUNTANT", "expense.manage", afterGrants) &&
      !can("ACCOUNTANT", "class.manage", afterGrants),
  );

  // ── 5. Teacher cross-branch leak (security fix 16) ──────────────────────
  const shared = await makeTeacher(centerA.id, "permissions-check-shared@kayedu.test", "Shared");
  await prisma.membership.create({
    data: scopedData(centerB.id, {
      userId: shared.user.id,
      role: "TEACHER" as Role,
      joinedAt: new Date(),
    }),
  });

  const rawMembershipCount = await prisma.membership.count({ where: { userId: shared.user.id } });
  check(
    "Sanity: this teacher really does have two memberships, one per center",
    rawMembershipCount === 2,
  );

  // The exact query lib/db/scoped.ts's `teachers.findById` runs.
  const teacherDetailRow = await prisma.membership.findFirst({
    where: scopedWhere(centerA.id, { id: shared.membership.id, role: "TEACHER" as Role }),
    include: { user: true },
  });
  check(
    "The teacher-detail query never includes the User's other Membership rows",
    teacherDetailRow !== null &&
      !("memberships" in (teacherDetailRow.user as object)) &&
      !("memberships" in (teacherDetailRow as object)),
  );

  // ── 6. Cross-branch grants (MembershipBranchGrant) ──────────────────────
  const managerHome = await prisma.membership.create({
    data: scopedData(centerA.id, {
      userId: (
        await prisma.user.create({
          data: { firstName: "M", lastName: "Home", email: "permissions-check-branchgrant@kayedu.test", locale: "en" },
        })
      ).id,
      role: "MANAGER" as Role,
      joinedAt: new Date(),
    }),
  });

  check(
    "MANAGER/RECEPTIONIST/ACCOUNTANT are branch-grantable; OWNER and TEACHER are not",
    isBranchGrantableRole("MANAGER") &&
      isBranchGrantableRole("RECEPTIONIST") &&
      isBranchGrantableRole("ACCOUNTANT") &&
      !isBranchGrantableRole("OWNER") &&
      !isBranchGrantableRole("TEACHER"),
  );

  await grantMembershipBranch(prisma, managerHome.id, centerB.id, "test-owner");
  const grantsByMembership = await membershipBranchGrantsFor(prisma, [managerHome.id]);
  check(
    "A branch grant widens this membership's reach to exactly the granted branch",
    (grantsByMembership.get(managerHome.id) ?? []).map((c) => c.id).includes(centerB.id),
  );

  await revokeMembershipBranch(prisma, managerHome.id, centerB.id);
  const afterRevoke = await membershipBranchGrantsFor(prisma, [managerHome.id]);
  check(
    "Revoking a branch grant is additive-only in reverse — it removes exactly that branch",
    (afterRevoke.get(managerHome.id) ?? []).length === 0,
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
      console.error(`\n${failures} permissions check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll permissions checks passed.");
  });
