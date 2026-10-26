/**
 * Tenant isolation check — the M1 acceptance gate:
 * "a user of Center A cannot load a Center B record by ID."
 *
 * Run with:  npm run check:isolation
 *
 * It exercises the real scoping primitives from lib/db/tenant-scope.ts (the
 * same ones lib/db/scoped.ts is built on), creates two throwaway centers,
 * asserts the cross-center reads are denied, and cleans up after itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { gatePrisma } from "./lib/gate-db.ts";
import { canInContext, type Permission } from "../lib/auth/permissions.ts";
import { resolveCenterRelations, roleForExperience } from "../lib/auth/relations.ts";
import { grantMembershipBranch, loadPermissionGrants } from "../lib/db/permissions.ts";
import { provisionCenterBaseline } from "../lib/db/provision.ts";
import { addTeacherMembership } from "../lib/db/teacher-membership.ts";
import {
  MissingCenterScopeError,
  TenantScopeError,
  requireScopedById,
  scopedFindById,
  scopedWhere,
} from "../lib/db/tenant-scope.ts";

const prisma = await gatePrisma();

const SLUG_A = "isolation-check-a";
const SLUG_B = "isolation-check-b";
// F1: a sibling branch in Center A's organization.
const SLUG_A2 = "isolation-check-a2";
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
  // The sibling first (it shares Center A's organization), then the rest.
  await prisma.center.deleteMany({ where: { slug: SLUG_A2 } });
  const orgs = await prisma.center.findMany({ where: { slug: { in: [SLUG_A, SLUG_B] } }, select: { organizationId: true } });
  await prisma.center.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
  await prisma.organization.deleteMany({
    where: { id: { in: orgs.map((row) => row.organizationId) }, centers: { none: {} } },
  });
  await prisma.user.deleteMany({
    where: {
      email: {
        in: ["isolation-a@kayedu.test", "isolation-b@kayedu.test", "isolation-manager@kayedu.test", "isolation-teacher@kayedu.test"],
      },
    },
  });
}

async function main() {
  await cleanup();

  const centerA = await prisma.center.create({
    data: { slug: SLUG_A, name: "Isolation A", organization: { create: { name: "Isolation A" } } },
  });
  const centerB = await prisma.center.create({
    data: { slug: SLUG_B, name: "Isolation B", organization: { create: { name: "Isolation B" } } },
  });

  const userA = await prisma.user.create({
    data: {
      email: "isolation-a@kayedu.test",
      firstName: "Owner",
      lastName: "A",
    },
  });
  const userB = await prisma.user.create({
    data: {
      email: "isolation-b@kayedu.test",
      firstName: "Owner",
      lastName: "B",
    },
  });

  await prisma.membership.create({
    data: { userId: userA.id, centerId: centerA.id, role: "OWNER" },
  });
  const membershipB = await prisma.membership.create({
    data: { userId: userB.id, centerId: centerB.id, role: "OWNER" },
  });

  // Branch (the old location-under-a-tenant model) was retired at M11 — a
  // room now belongs to the centre directly, the same non-money,
  // centerId-scoped shape Branch used to have, so it exercises this gate
  // exactly as before (docs/03-build-order.md M11: "check:isolation passes
  // with ZERO changes to its assertions" — the fixture model changed because
  // the old one no longer exists, the assertions below did not).
  const roomA = await prisma.room.create({
    data: { centerId: centerA.id, name: "A main" },
  });
  const roomB = await prisma.room.create({
    data: { centerId: centerB.id, name: "B main" },
  });

  console.log("Tenant isolation check");

  // 1. The happy path still works inside the active center.
  const ownRoom = await scopedFindById(prisma.room, centerA.id, roomA.id);
  check("Center A reads its own room by id", ownRoom?.id === roomA.id);

  // 2. The acceptance gate: another center's id must not resolve.
  const foreignRoom = await scopedFindById(
    prisma.room,
    centerA.id,
    roomB.id,
  );
  check(
    "Center A cannot read a Center B room by id",
    foreignRoom === null,
    foreignRoom ? `leaked room ${foreignRoom.id}` : "",
  );

  // 3. requireScopedById turns the same attempt into a hard error.
  let threwScopeError = false;
  try {
    await requireScopedById(prisma.room, centerA.id, roomB.id, "Room");
  } catch (error) {
    threwScopeError = error instanceof TenantScopeError;
  }
  check("requireScopedById throws TenantScopeError across centers", threwScopeError);

  // 4. A scoped list never contains another center's rows.
  const membershipsInA = await prisma.membership.findMany({
    where: scopedWhere(centerA.id),
  });
  check(
    "Scoped membership list excludes Center B rows",
    membershipsInA.every((row) => row.centerId === centerA.id) &&
      !membershipsInA.some((row) => row.id === membershipB.id),
  );

  // 5. Building a scoped query without a centerId is a loud failure, never a
  //    silent unscoped read.
  let threwMissingScope = false;
  try {
    scopedWhere("", { id: roomB.id });
  } catch (error) {
    threwMissingScope = error instanceof MissingCenterScopeError;
  }
  check("scopedWhere refuses to build an unscoped where", threwMissingScope);

  await checkBranchTargetedAdds(centerA.id, centerB.id, userA.id);
}

// ── 6. F1: a branch-targeted invite / Add teacher ──────────────────────────
// Settings → Staff "Invite" and Teachers → "Add teacher" post a branch id.
// The actions re-resolve the actor at that branch through
// `getTenantContextForBranch` (lib/auth/tenant.ts) — the relation resolution
// + `buildContext` + `ctxCan` every request runs. That module needs the
// Next runtime, so this composes the same primitives it is built on:
// `resolveCenterRelations` → `roleForExperience("center")` →
// `loadPermissionGrants` → `canInContext`.

async function permittedAt(userId: string, centerId: string, permission: Permission): Promise<boolean> {
  const relations = await resolveCenterRelations(prisma, userId);
  const relation = relations.find((item) => item.center.id === centerId);
  if (!relation) return false;
  const role = roleForExperience(relation, "center");
  if (role === null) return false;
  const grants = role === "STUDENT" ? {} : await loadPermissionGrants(prisma, centerId, role);
  return canInContext({ experienceDenied: false, role, grants }, permission);
}

async function checkBranchTargetedAdds(centerAId: string, centerBId: string, ownerAId: string) {
  console.log("\nF1 — branch-targeted invite and Add teacher");

  // A second branch in Center A's organization, with the baseline matrix.
  const centerA = await prisma.center.findUniqueOrThrow({ where: { id: centerAId } });
  const sibling = await prisma.center.create({
    data: { slug: SLUG_A2, name: "Isolation A2", organizationId: centerA.organizationId },
  });
  await prisma.$transaction((tx) => provisionCenterBaseline(tx, sibling.id));
  await prisma.$transaction((tx) => provisionCenterBaseline(tx, centerAId));

  const manager = await prisma.user.create({ data: { email: "isolation-manager@kayedu.test", firstName: "Manager", lastName: "A" } });
  const managerMembership = await prisma.membership.create({ data: { userId: manager.id, centerId: centerAId, role: "MANAGER" } });

  check(
    "An Owner may invite at a sibling branch of their organization (membership.role.assign resolves there)",
    await permittedAt(ownerAId, sibling.id, "membership.role.assign"),
  );
  check(
    "A branch-aware invite to a branch the actor doesn't hold is refused — another customer's branch resolves nothing",
    !(await permittedAt(ownerAId, centerBId, "membership.role.assign")) &&
      !(await permittedAt(ownerAId, centerBId, "teacher.manage")),
  );
  check(
    "A MANAGER with no branch grant resolves nothing at the sibling branch — Add teacher there is refused",
    !(await permittedAt(manager.id, sibling.id, "teacher.manage")),
  );
  await grantMembershipBranch(prisma, managerMembership.id, sibling.id, ownerAId);
  check(
    "Granted the sibling branch, the MANAGER may add a teacher there (teacher.manage at that branch's own matrix)…",
    await permittedAt(manager.id, sibling.id, "teacher.manage"),
  );
  check(
    "…but still cannot invite there: D-22, inviting is OWNER-only at every branch",
    !(await permittedAt(manager.id, sibling.id, "membership.role.assign")),
  );
  await prisma.permissionGrant.update({
    where: { centerId_role_action: { centerId: sibling.id, role: "MANAGER", action: "teacher.manage" } },
    data: { allowed: false },
  });
  check(
    "The permission is checked at the target branch: switching teacher.manage off there refuses it, though the home branch still grants it",
    !(await permittedAt(manager.id, sibling.id, "teacher.manage")) && (await permittedAt(manager.id, centerAId, "teacher.manage")),
  );

  // The row lands in the target branch: the action writes with the target
  // context's centre id, through the one teacher-creation path.
  const added = await prisma.$transaction((tx) =>
    addTeacherMembership(
      tx,
      sibling.id,
      { firstName: "Isolation", lastName: "Teacher", email: "isolation-teacher@kayedu.test", phone: null, altPhone: null, locale: "en" },
      { actorUserId: ownerAId, linkUserId: null, via: "teacher.add", refusePrivileged: false },
    ),
  );
  const teacherRows = added.ok ? await prisma.membership.findMany({ where: { userId: added.userId } }) : [];
  check(
    "A teacher added for the sibling branch has exactly one membership, at that branch",
    added.ok && teacherRows.length === 1 && teacherRows[0].centerId === sibling.id && teacherRows[0].role === "TEACHER",
    JSON.stringify(added),
  );

  // Static: the actions never trust the posted id.
  const tenant = readFileSync(join(ROOT, "lib", "auth", "tenant.ts"), "utf8");
  const staffActions = readFileSync(join(ROOT, "app", "[locale]", "(center)", "settings", "staff", "actions.ts"), "utf8");
  const teacherActions = readFileSync(join(ROOT, "app", "[locale]", "(center)", "teachers", "actions.ts"), "utf8");
  check(
    "getTenantContextForBranch looks the id up among the actor's own relations and builds the context the usual way (static)",
    /export async function getTenantContextForBranch[\s\S]{0,600}getUserCenterRelations\(user\.id\)[\s\S]{0,300}buildContext\(user, relation, experience\)/.test(tenant),
  );
  check(
    "createInvitationAction checks membership.role.assign on the target context and writes through scoped(target) (static)",
    /getTenantContextForBranch\(branchId, "center"\)/.test(staffActions) &&
      /ctxCan\(target, "membership\.role\.assign"\)/.test(staffActions) &&
      /scoped\(target\)/.test(staffActions),
  );
  check(
    "createTeacherAction resolves teacherScope(branchId) — getTenantContextForBranch + teacher.manage at that branch (static)",
    /teacherScope\(branchId\)/.test(teacherActions) &&
      /getTenantContextForBranch\(branchId, "center"\)/.test(teacherActions) &&
      /ctxCan\(ctx, "teacher\.manage"\)/.test(teacherActions) &&
      /createTeacherMembership\(\s*prisma,\s*scope\.ctx\.center\.id/.test(teacherActions),
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
      console.error(`\n${failures} isolation check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll isolation checks passed.");
  });
