import type { Role } from "@prisma/client";

/**
 * The configurable, action-level permission matrix (M12,
 * docs/02-architecture.md §6.1, docs/00-master-product-spec.md §3).
 *
 * Phase 1 shipped a hardcoded `Record<TenantRole, Permission[]>` plus two
 * `CenterSettings` boolean grants. M12 replaces both with stored
 * `PermissionGrant` rows (`centerId × role × action × allowed`,
 * `lib/db/permissions.ts`) — this module stays the single place the
 * `Permission` union and the resolution algorithm live, and it stays free of
 * runtime imports so the acceptance gates can exercise it outside Next.
 */

export type TenantRole = Role | "STUDENT" | "PLATFORM_ADMIN" | "PARENT";

export const PERMISSIONS = [
  // Ownership — OWNER only, forced true for OWNER and forbidden to every
  // other role regardless of any stored grant (see the ceiling below).
  "center.ownership.manage", // transfer / close the center
  "permission.manage", // edit the permission matrix (M12)
  "membership.role.assign", // grant/change a member's role (M12)
  "membership.branch.grant", // widen a member's branch access (M12)
  // Center-level
  "center.settings.edit",
  "center.branding.edit",
  "center.profit.view",
  // Staff & people
  "staff.invite",
  "staff.manage",
  "teacher.manage",
  "teacher.delete",
  "student.manage",
  "student.delete",
  "student.promote",
  "student.block",
  // Academic
  "class.manage",
  "class.delete",
  "session.manage",
  "session.cancel",
  // Daily loop
  "session.view",
  "reception.use",
  "attendance.record",
  "attendance.correct",
  "payment.record",
  "payment.void",
  "payment.refund",
  // Settlements (M14) — creating a settlement, and each DRAFT→APPROVED /
  // APPROVED→PAID transition, all gate on this one action.
  "settlement.manage",
  // Money & reporting
  "expense.manage",
  "analytics.center.view",
  "analytics.own.view",
  // Workflow
  "approvals.manage",
  "changeRequest.create",
  // A teacher's own queue of students requesting to join their classes (M15,
  // spec §4.2 item 6) — a separate decision from the centre's own
  // `approvals.manage` queue, and scoped in the action itself to reservations
  // whose class this teacher actually teaches.
  "reservation.manage.own",
  // Trust
  "audit.view",
  // Parent accounts (M16) — the OD-6 placeholder seam: a centre staff member
  // manually flips a PENDING ParentLink to VERIFIED from the student's
  // profile. Not OD-6's real answer, just an obvious, gated, audited seam
  // until OD-6 settles who/how actually verifies.
  "parent.link.manage",
  // Platform
  "platform.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Ownership actions: forced true for OWNER regardless of any stored
 * `PermissionGrant` row, and forbidden to every other role regardless of any
 * row (docs/02-architecture.md §6.1 "a hardcoded grantable ceiling still
 * exists"). This is what keeps "an OWNER can never be stripped of ownership
 * actions" and "a MANAGER cannot reach the matrix, assign a role, or grant a
 * branch — by UI or by direct action call" true even against a bad or
 * malicious `PermissionGrant` row, not merely against the UI.
 */
const OWNER_ONLY_ACTIONS: readonly Permission[] = [
  "center.ownership.manage",
  "permission.manage",
  "membership.role.assign",
  "membership.branch.grant",
];

/**
 * A hard denylist on top of the open matrix: actions a role can never be
 * granted, however a centre configures its matrix (docs/00-master-product-spec.md
 * §3: "a TEACHER can never be granted center.profit.view"). Everything else is
 * genuinely configurable — M12 deliberately opens the matrix beyond the old
 * narrow per-role allowlist (`GRANTABLE_PERMISSIONS`), so a centre may now
 * grant, say, RECEPTIONIST `analytics.center.view` if it wants to.
 */
const FORBIDDEN_CEILING: Partial<Record<TenantRole, readonly Permission[]>> = {
  TEACHER: ["center.profit.view", "analytics.center.view"],
};

/** Resolved-role actions that are not Memberships and never go through the matrix. */
const PLATFORM_ADMIN_ACTIONS: readonly Permission[] = ["platform.manage", "audit.view"];

/**
 * Platform-level actions no centre's matrix may ever grant to any Membership
 * role, OWNER included — these belong to `User.isPlatformAdmin`, a wholly
 * separate axis from a centre's own role matrix.
 */
const PLATFORM_ONLY_ACTIONS: readonly Permission[] = ["platform.manage"];

/**
 * The resolved grant map for one role at one center — loaded fresh per
 * request from `PermissionGrant` rows (`lib/db/permissions.ts`), the direct
 * replacement for the old `permissionGrantsFromSettings()` seam. Deny by
 * default: a permission with no entry here is denied.
 */
export type PermissionGrants = Partial<Record<Permission, boolean>>;

/**
 * Resolution order (docs/02-architecture.md §6.1): platform ceiling → the
 * centre's stored grant → deny. `STUDENT`/`PLATFORM_ADMIN` are resolved roles,
 * not `Role` enum values — they never have `PermissionGrant` rows, so they are
 * settled before the matrix is even consulted.
 */
export function can(
  role: TenantRole,
  permission: Permission,
  grants?: PermissionGrants,
): boolean {
  if (PLATFORM_ONLY_ACTIONS.includes(permission)) return role === "PLATFORM_ADMIN";
  if (role === "PLATFORM_ADMIN") return PLATFORM_ADMIN_ACTIONS.includes(permission);
  // PARENT is a resolved role, not a Membership — it never has a
  // PermissionGrant row, and it holds no permission at all: the parent
  // portal has no write path of any kind (00-master-product-spec.md §4.5,
  // §5.1 "Parent role & portal"). This denies unconditionally, the same
  // shape as STUDENT, so a future stray grant row could never reopen one.
  if (role === "STUDENT" || role === "PARENT") return false;

  if (OWNER_ONLY_ACTIONS.includes(permission)) return role === "OWNER";
  if (FORBIDDEN_CEILING[role]?.includes(permission)) return false;

  return grants?.[permission] === true;
}

export class PermissionError extends Error {
  readonly permission: Permission;
  readonly role: TenantRole;

  constructor(role: TenantRole, permission: Permission) {
    super(`Role ${role} is not permitted to perform "${permission}".`);
    this.name = "PermissionError";
    this.role = role;
    this.permission = permission;
  }
}

/** Server-side authoritative check. Client-side `can()` only hides controls. */
export function assertCan(
  role: TenantRole,
  permission: Permission,
  grants?: PermissionGrants,
): void {
  if (!can(role, permission, grants)) throw new PermissionError(role, permission);
}

export function permissionsFor(role: TenantRole, grants?: PermissionGrants): Permission[] {
  return PERMISSIONS.filter((permission) => can(role, permission, grants));
}

/**
 * Every action a centre's matrix screen may actually edit for a given role —
 * the ownership actions are excluded (they are never stored rows, see
 * `OWNER_ONLY_ACTIONS` above) and a role's own forbidden ceiling is excluded
 * too, since no toggle there could ever take effect.
 */
export function editableActionsFor(role: Role): Permission[] {
  const forbidden = FORBIDDEN_CEILING[role] ?? [];
  return PERMISSIONS.filter(
    (permission) =>
      !OWNER_ONLY_ACTIONS.includes(permission) &&
      !PLATFORM_ONLY_ACTIONS.includes(permission) &&
      !forbidden.includes(permission),
  );
}

/**
 * The roles the `/settings/permissions` matrix screen actually edits. OWNER
 * is excluded — its actions are forced/ceiling-protected, never a stored row
 * (see `OWNER_ONLY_ACTIONS` above and docs/02-architecture.md §6.1).
 */
export const MATRIX_ROLES: readonly Role[] = [
  "MANAGER",
  "RECEPTIONIST",
  "ACCOUNTANT",
  "TEACHER",
];

/**
 * The baseline `PermissionGrant` rows a freshly provisioned center starts
 * with — seeded once at creation (`lib/db/platform.ts`'s
 * `createCenterWithSettings`), then freely reconfigurable through the matrix
 * from that point on. This is the same baseline the M12 migration backfilled
 * onto every pre-existing center (`prisma/migrations/20260906224000_m12_permission_matrix`),
 * kept here as the one canonical list so a brand-new center's provisioning
 * path can never quietly drift from what that one-time migration established.
 */
const MANAGER_BASELINE: readonly Permission[] = [
  "center.settings.edit",
  "center.branding.edit",
  "center.profit.view",
  "staff.invite",
  "staff.manage",
  "teacher.manage",
  "teacher.delete",
  "student.manage",
  "student.delete",
  "student.promote",
  "student.block",
  "class.manage",
  "class.delete",
  "session.manage",
  "session.cancel",
  "session.view",
  "reception.use",
  "attendance.record",
  "attendance.correct",
  "payment.record",
  "payment.void",
  "payment.refund",
  "settlement.manage",
  "expense.manage",
  "analytics.center.view",
  "approvals.manage",
  "audit.view",
  "parent.link.manage",
];

export const DEFAULT_ROLE_GRANTS: Record<Role, readonly Permission[]> = {
  OWNER: MANAGER_BASELINE,
  MANAGER: MANAGER_BASELINE,
  RECEPTIONIST: [
    "reception.use",
    "session.view",
    "attendance.record",
    "payment.record",
    "student.manage",
  ],
  ACCOUNTANT: ["analytics.center.view", "expense.manage"],
  TEACHER: [
    "analytics.own.view",
    "changeRequest.create",
    "student.block",
    "reservation.manage.own",
  ],
};

export const CENTER_STAFF_ROLES: readonly Role[] = [
  "OWNER",
  "MANAGER",
  "RECEPTIONIST",
  "ACCOUNTANT",
];

/** Highest-authority role first — used to resolve a user's role at a center. */
export const ROLE_PRECEDENCE: readonly Role[] = [
  "OWNER",
  "MANAGER",
  "RECEPTIONIST",
  "ACCOUNTANT",
  "TEACHER",
];

export function isCenterStaffRole(role: TenantRole): role is Role {
  return (CENTER_STAFF_ROLES as readonly string[]).includes(role);
}

/**
 * Branch-scoped roles a `MembershipBranchGrant` may widen (M12,
 * docs/01-data-model.md "Organization layer"). OWNER already resolves every
 * branch under its organization; TEACHER's multi-center reach is a second
 * real `Membership` row, not a widening of one — so neither is grantable
 * here.
 */
export const BRANCH_GRANTABLE_ROLES: readonly Role[] = [
  "MANAGER",
  "RECEPTIONIST",
  "ACCOUNTANT",
];

export function isBranchGrantableRole(role: Role): boolean {
  return (BRANCH_GRANTABLE_ROLES as readonly string[]).includes(role);
}
