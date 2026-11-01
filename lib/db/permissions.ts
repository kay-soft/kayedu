import type { Center, PrismaClient, Role } from "@prisma/client";

// Relative imports only, and a `PrismaClient` taken as a parameter rather
// than importing the app singleton — this module stays resolvable outside
// the Next.js runtime, the same discipline lib/db/organizations.ts and
// lib/db/sessions.ts follow, so `npm run check:permissions` can exercise the
// real production functions (docs/02-architecture.md §5).
import type { Permission, PermissionGrants } from "../auth/permissions.ts";
import { ACCESSIBLE_CENTER } from "./platform.ts";

/**
 * The resolved grant map for one role at one center — what
 * `lib/auth/tenant.ts`'s `buildContext()` feeds `can()` as `ctx.grants`, the
 * direct replacement for the retired `permissionGrantsFromSettings()`.
 */
export async function loadPermissionGrants(
  db: PrismaClient,
  centerId: string,
  role: Role,
): Promise<PermissionGrants> {
  const rows = await db.permissionGrant.findMany({
    where: { centerId, role },
    select: { action: true, allowed: true },
  });
  const grants: PermissionGrants = {};
  for (const row of rows) {
    grants[row.action as Permission] = row.allowed;
  }
  return grants;
}

export type PermissionGrantRow = { role: Role; action: string; allowed: boolean };

/** Every stored row for a center, across every role — what the matrix screen renders. */
export async function listPermissionGrants(
  db: PrismaClient,
  centerId: string,
): Promise<PermissionGrantRow[]> {
  return db.permissionGrant.findMany({
    where: { centerId },
    select: { role: true, action: true, allowed: true },
    orderBy: [{ role: "asc" }, { action: "asc" }],
  });
}

export type PermissionGrantWrite = { role: Role; action: string; allowed: boolean };

/**
 * Replaces a center's matrix rows for exactly the (role, action) pairs
 * supplied, in one transaction — the matrix screen submits its whole grid at
 * once, not one toggle at a time. The grantable ceiling (`lib/auth/permissions.ts`)
 * is enforced by the caller *before* this is reached; this module is
 * deliberately mechanical, so the ceiling has exactly one implementation.
 */
export async function savePermissionGrants(
  db: PrismaClient,
  centerId: string,
  writes: PermissionGrantWrite[],
): Promise<void> {
  if (writes.length === 0) return;
  await db.$transaction(
    writes.map((write) =>
      db.permissionGrant.upsert({
        where: {
          centerId_role_action: { centerId, role: write.role, action: write.action },
        },
        update: { allowed: write.allowed },
        create: { centerId, role: write.role, action: write.action, allowed: write.allowed },
      }),
    ),
  );
}

/**
 * The extra branches every supplied membership may additionally reach
 * (M12, docs/01-data-model.md "Organization layer") — the seam
 * `getUserCenterRelations()` widens through, mirroring the Owner/organization
 * widening it already does. Keyed by `membershipId` so the caller can look up
 * each real membership's grants independently.
 */
export async function membershipBranchGrantsFor(
  db: PrismaClient,
  membershipIds: string[],
): Promise<Map<string, Center[]>> {
  if (membershipIds.length === 0) return new Map();
  const rows = await db.membershipBranchGrant.findMany({
    where: {
      membershipId: { in: membershipIds },
      center: ACCESSIBLE_CENTER,
    },
    include: { center: true },
  });
  const byMembership = new Map<string, Center[]>();
  for (const row of rows) {
    const list = byMembership.get(row.membershipId) ?? [];
    list.push(row.center);
    byMembership.set(row.membershipId, list);
  }
  return byMembership;
}

export function grantMembershipBranch(
  db: PrismaClient,
  membershipId: string,
  centerId: string,
  grantedBy: string,
) {
  return db.membershipBranchGrant.upsert({
    where: { membershipId_centerId: { membershipId, centerId } },
    update: {},
    create: { membershipId, centerId, grantedBy },
  });
}

export function revokeMembershipBranch(
  db: PrismaClient,
  membershipId: string,
  centerId: string,
) {
  return db.membershipBranchGrant.deleteMany({ where: { membershipId, centerId } });
}
