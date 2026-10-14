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
 *  7. (P1) The provisioning baseline and the nav it unlocks — the regression
 *     for "an Owner / Manager sees only Dashboard". `provisionCenterBaseline`
 *     yields the full baseline (idempotently, without undoing a deliberate
 *     change); `createCenterWithSettings` (Super Admin) and the demo seed both
 *     go through it (static); a freshly provisioned centre gives its owner,
 *     manager, receptionist, accountant and teacher exactly their expected nav
 *     items, computed through the shell's own functions; and every nav item
 *     shows on the permission its page asserts.
 *
 * Needs a reachable database and cleans up after itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient, type Role } from "@prisma/client";
import { scopedData, scopedWhere } from "../lib/db/tenant-scope.ts";
import { can, isBranchGrantableRole } from "../lib/auth/permissions.ts";
import { resolveCenterRelations, roleForExperience } from "../lib/auth/relations.ts";
import { createCenterWithSettings } from "../lib/db/platform.ts";
import {
  baselineGrantKeys,
  centerBaselineGaps,
  hasFullBaseline,
  provisionCenterBaseline,
} from "../lib/db/provision.ts";
import { CENTER_NAV, TEACHER_NAV, navForExperience } from "../components/shell/nav.ts";
import { pageGateFor } from "./lib/nav-gates.ts";
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
// P1 (part 7): a centre made by Super Admin provisioning, one made the way the
// seed makes them, and one left bare on purpose.
const SLUG_P1_ADMIN = "permissions-check-p1-admin";
const SLUG_P1_SEED = "permissions-check-p1-seed";
const SLUG_P1_BARE = "permissions-check-p1-bare";
const P1_ORG_PREFIX = "Permissions Check P1";
const ROOT = join(import.meta.dirname, "..");

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
  await prisma.center.deleteMany({
    where: { slug: { in: [SLUG_A, SLUG_B, SLUG_P1_ADMIN, SLUG_P1_SEED, SLUG_P1_BARE] } },
  });
  await prisma.organization.deleteMany({
    where: { OR: [{ name: ORG_NAME }, { name: { startsWith: P1_ORG_PREFIX } }] },
  });
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

  await checkProvisioningBaseline();
}

// ── 7. P1: the provisioning baseline and the nav it unlocks ─────────────────

/** What each role is meant to see in the sidebar of a centre that works. */
const EXPECTED_NAV: Record<"OWNER" | "MANAGER" | "RECEPTIONIST" | "ACCOUNTANT", string[]> = {
  OWNER: ["dashboard", "reception", "sessions", "approvals", "classes", "students", "teachers", "analytics", "expenses", "refunds", "settlements", "settings"],
  MANAGER: ["dashboard", "reception", "sessions", "approvals", "classes", "students", "teachers", "analytics", "expenses", "refunds", "settlements", "settings"],
  RECEPTIONIST: ["dashboard", "reception", "sessions", "students"],
  ACCOUNTANT: ["dashboard", "analytics", "expenses"],
};
const EXPECTED_TEACHER_NAV = ["dashboard", "sessions", "students", "classes", "approvals", "settlements"];

async function navFor(centerId: string, userId: string, role: Role): Promise<string[]> {
  const relations = await resolveCenterRelations(prisma, userId);
  const relation = relations.find((item) => item.center.id === centerId);
  if (!relation) return ["(no relation)"];
  const experience = role === "TEACHER" ? "teacher" : "center";
  const resolved = roleForExperience(relation, experience) as Role;
  const grants = await loadPermissionGrants(prisma, centerId, resolved);
  return navForExperience(experience, resolved, grants).map((item) => item.labelKey);
}

async function staffMember(centerId: string, tag: string, role: Role) {
  const user = await prisma.user.create({
    data: { firstName: tag, lastName: role, email: `permissions-check-p1-${tag}-${role.toLowerCase()}@kayedu.test`, locale: "en" },
  });
  await prisma.membership.create({
    data: scopedData(centerId, { userId: user.id, role, joinedAt: new Date(), firstName: tag, lastName: role }),
  });
  return user;
}

async function checkProvisioningBaseline() {
  console.log("\n7. P1 — the provisioning baseline and the nav it unlocks");
  const expectedRows = baselineGrantKeys().length;

  // (a) Super Admin provisioning, end to end.
  const created = await createCenterWithSettings(prisma, {
    name: `${P1_ORG_PREFIX} Admin`,
    slug: SLUG_P1_ADMIN,
    themeColor: "#2563EB",
    invite: {
      email: "permissions-check-p1-invite@kayedu.test",
      token: "permissions-check-p1-token",
      invitedBy: "permissions-check",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  if (!created.ok) throw new Error(`createCenterWithSettings: ${created.error}`);
  const adminGaps = await centerBaselineGaps(prisma, created.center.id);
  check(
    `createCenterWithSettings yields the full baseline (settings + ${expectedRows} grant rows + payment methods)`,
    hasFullBaseline(adminGaps) &&
      (await prisma.permissionGrant.count({ where: { centerId: created.center.id } })) === expectedRows,
    JSON.stringify({ missing: adminGaps.missingGrants.length, settings: adminGaps.missingSettings, methods: adminGaps.activePaymentMethods }),
  );

  // (b) The function itself, the way the seed uses it — on a bare centre.
  const org = await prisma.organization.create({ data: { name: `${P1_ORG_PREFIX} Seed` } });
  const seeded = await prisma.center.create({ data: { slug: SLUG_P1_SEED, name: "Permissions Check P1 Seed", organizationId: org.id } });
  const report = await prisma.$transaction((tx) => provisionCenterBaseline(tx, seeded.id));
  check(
    "provisionCenterBaseline on a bare centre creates settings, every baseline grant row and the default payment methods",
    report.settingsCreated && report.grantsCreated === expectedRows && report.paymentMethodsCreated === 3,
    JSON.stringify(report),
  );
  check("…and the centre then has no baseline gap", hasFullBaseline(await centerBaselineGaps(prisma, seeded.id)));

  // Idempotent, and never undoes a deliberate change an Owner made.
  await savePermissionGrants(prisma, seeded.id, [{ role: "RECEPTIONIST", action: "student.manage", allowed: false }]);
  const again = await prisma.$transaction((tx) => provisionCenterBaseline(tx, seeded.id));
  const stillOff = await loadPermissionGrants(prisma, seeded.id, "RECEPTIONIST");
  check(
    "Running it again creates nothing and does not flip a grant an Owner switched off",
    !again.settingsCreated && again.grantsCreated === 0 && again.paymentMethodsCreated === 0 && stillOff["student.manage"] === false,
    JSON.stringify(again),
  );
  await savePermissionGrants(prisma, seeded.id, [{ role: "RECEPTIONIST", action: "student.manage", allowed: true }]);
  check(
    "A switched-off baseline action is a configuration, not a gap",
    hasFullBaseline(await centerBaselineGaps(prisma, seeded.id)),
  );

  // (c) Static: every centre-creating path goes through the one function.
  const platformSource = readFileSync(join(ROOT, "lib", "db", "platform.ts"), "utf8");
  const seedSource = readFileSync(join(ROOT, "prisma", "seed.ts"), "utf8");
  check(
    "createCenterWithSettings calls provisionCenterBaseline (static)",
    /provisionCenterBaseline\(/.test(platformSource) && /from "\.\/provision\.ts"/.test(platformSource),
  );
  check("prisma/seed.ts calls provisionCenterBaseline (static)", /provisionCenterBaseline\(/.test(seedSource));
  check(
    "Neither re-implements the baseline — no DEFAULT_ROLE_GRANTS or permission-grant write of their own (static)",
    !/DEFAULT_ROLE_GRANTS|permissionGrants:|permissionGrant\.create/.test(platformSource) &&
      !/DEFAULT_ROLE_GRANTS|permissionGrants:|permissionGrant\.create/.test(seedSource),
  );
  check(
    "createCenterWithSettings no longer builds the settings row or payment methods itself (static)",
    !/settings:\s*\{|paymentMethods:\s*\{|defaultPaymentMethodRows/.test(platformSource),
  );

  // (d) The nav a freshly provisioned centre gives each role — through the
  // shell's own functions (relation resolution → grant load → navForExperience).
  const owner = await staffMember(created.center.id, "adm", "OWNER");
  const manager = await staffMember(created.center.id, "adm", "MANAGER");
  const receptionist = await staffMember(created.center.id, "adm", "RECEPTIONIST");
  const accountant = await staffMember(created.center.id, "adm", "ACCOUNTANT");
  const teacher = await staffMember(created.center.id, "adm", "TEACHER");
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
  for (const [label, user, role] of [
    ["owner", owner, "OWNER"],
    ["manager", manager, "MANAGER"],
    ["receptionist", receptionist, "RECEPTIONIST"],
    ["accountant", accountant, "ACCOUNTANT"],
  ] as const) {
    const nav = await navFor(created.center.id, user.id, role);
    check(
      `A freshly provisioned centre: its ${label} sees ${EXPECTED_NAV[role].length} nav items`,
      same(nav, EXPECTED_NAV[role]),
      `got [${nav.join(", ")}]`,
    );
  }
  const teacherNav = await navFor(created.center.id, teacher.id, "TEACHER");
  check("A freshly provisioned centre: its teacher sees the teacher nav", same(teacherNav, EXPECTED_TEACHER_NAV), `got [${teacherNav.join(", ")}]`);

  // The seed's path gives the same answer as the admin path.
  const seedOwner = await staffMember(seeded.id, "seed", "OWNER");
  const seedRecep = await staffMember(seeded.id, "seed", "RECEPTIONIST");
  check(
    "The seed's path gives the same owner and receptionist nav as Super Admin provisioning",
    same(await navFor(seeded.id, seedOwner.id, "OWNER"), EXPECTED_NAV.OWNER) &&
      same(await navFor(seeded.id, seedRecep.id, "RECEPTIONIST"), EXPECTED_NAV.RECEPTIONIST),
  );

  // The regression P1 found — a centre with no baseline left its Owner nothing
  // but the ungated Dashboard — is closed for OWNER at the root since SEC-2a
  // (SEC-45): OWNER holds every non-platform action whatever rows exist, so a
  // missing baseline can no longer lock an Owner out. (Was: "…shows its Owner
  // only the Dashboard".) The other roles stay deny-by-default — the gaps
  // check below still reports every missing row.
  const bareOrg = await prisma.organization.create({ data: { name: `${P1_ORG_PREFIX} Bare` } });
  const bare = await prisma.center.create({ data: { slug: SLUG_P1_BARE, name: "Permissions Check P1 Bare", organizationId: bareOrg.id } });
  const bareOwner = await staffMember(bare.id, "bare", "OWNER");
  check(
    "SEC-45: a centre created WITHOUT the baseline still gives its Owner the full Owner nav",
    same(await navFor(bare.id, bareOwner.id, "OWNER"), EXPECTED_NAV.OWNER),
  );
  check("…and centerBaselineGaps reports every baseline row missing", (await centerBaselineGaps(prisma, bare.id)).missingGrants.length === expectedRows);

  // (e) The page gate is the authority: each nav item's permission is exactly
  // the one its page asserts.
  for (const [experience, defs] of [["center", CENTER_NAV], ["teacher", TEACHER_NAV]] as const) {
    const differing = defs.filter((def) => {
      const page = pageGateFor(experience, def.href);
      return page.found && page.permission !== (def.permission ?? null);
    });
    check(
      `Every ${experience} nav item shows on exactly its page's permission`,
      differing.length === 0,
      differing.map((def) => `${def.href}: nav=${def.permission ?? "-"}`).join("; "),
    );
    const unresolved = defs.filter((def) => !pageGateFor(experience, def.href).found);
    check(`Every ${experience} nav item has a page file to compare against`, unresolved.length === 0, unresolved.map((d) => d.href).join(", "));
  }
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
