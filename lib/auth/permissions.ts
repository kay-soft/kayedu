import type { CenterSettings, Role } from "@prisma/client";

/**
 * Hardcoded permission map (docs/02-architecture.md §6, spec §3).
 * Not a dynamic permission engine — Phase 1 keeps roles fixed.
 */

export type TenantRole = Role | "STUDENT" | "PLATFORM_ADMIN";

export const PERMISSIONS = [
  // Center-level
  "center.ownership.manage", // transfer / close the center — Owner only
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
  "reception.use",
  "attendance.record",
  "attendance.correct",
  "payment.record",
  "payment.void",
  // Money & reporting
  "expense.manage",
  "analytics.center.view",
  "analytics.own.view",
  // Workflow
  "approvals.manage",
  "changeRequest.create",
  // Trust
  "audit.view",
  // Platform
  "platform.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MANAGER_PERMISSIONS: readonly Permission[] = [
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
  "reception.use",
  "attendance.record",
  "attendance.correct",
  "payment.record",
  "payment.void",
  "expense.manage",
  "analytics.center.view",
  "approvals.manage",
  "audit.view",
];

const ROLE_PERMISSIONS: Record<TenantRole, readonly Permission[]> = {
  // Owner = Manager + ownership actions.
  OWNER: ["center.ownership.manage", ...MANAGER_PERMISSIONS],
  MANAGER: MANAGER_PERMISSIONS,
  // Daily ops only. Profit and corrections are denied by default (spec §3).
  RECEPTIONIST: [
    "reception.use",
    "attendance.record",
    "payment.record",
    "student.manage",
  ],
  // Teachers act on their own data; the center grants financial visibility.
  TEACHER: ["analytics.own.view", "changeRequest.create", "student.block"],
  STUDENT: [],
  PLATFORM_ADMIN: ["platform.manage", "audit.view"],
};

/**
 * Permissions a center may *additionally* grant to a role via center settings.
 * Grants can only add; they can never take away a role's baseline.
 * The settings UI that flips these lands in M2 (center configuration).
 */
const GRANTABLE_PERMISSIONS: Partial<Record<TenantRole, readonly Permission[]>> = {
  RECEPTIONIST: ["attendance.correct", "center.profit.view"],
  TEACHER: ["analytics.own.view"],
};

export type PermissionGrants = Partial<Record<Permission, boolean>>;

/**
 * Center settings that widen a role's baseline (docs/02-architecture.md §6).
 * This is the single seam — nothing else reads the toggle columns.
 *
 * A grant only *adds*, and only for a permission listed as grantable for that
 * role above. Both toggles below are receptionist-only there, so flipping one
 * cannot widen anyone else: a TEACHER carrying `center.profit.view` in grants
 * still fails `can()`, because profit is not in TEACHER's grantable set.
 *
 * Both default to false — spec §3 denies a receptionist profit and
 * corrections until a center deliberately grants them.
 *
 * It lives here, beside the map it feeds, rather than in lib/auth/tenant.ts:
 * this module has no runtime imports, so the check can be exercised outside
 * the Next.js runtime (same reasoning as lib/db/tenant-scope.ts).
 */
export function permissionGrantsFromSettings(
  settings: Pick<
    CenterSettings,
    "receptionistCanViewProfit" | "receptionistCanCorrectAttendance"
  > | null,
): PermissionGrants {
  const grants: PermissionGrants = {};
  if (!settings) return grants;
  if (settings.receptionistCanViewProfit) grants["center.profit.view"] = true;
  if (settings.receptionistCanCorrectAttendance) {
    grants["attendance.correct"] = true;
  }
  return grants;
}

export function can(
  role: TenantRole,
  permission: Permission,
  grants?: PermissionGrants,
): boolean {
  if (ROLE_PERMISSIONS[role]?.includes(permission)) return true;
  if (grants?.[permission] !== true) return false;
  return GRANTABLE_PERMISSIONS[role]?.includes(permission) ?? false;
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

export const CENTER_STAFF_ROLES: readonly Role[] = ["OWNER", "MANAGER", "RECEPTIONIST"];

/** Highest-authority role first — used to resolve a user's role at a center. */
export const ROLE_PRECEDENCE: readonly Role[] = [
  "OWNER",
  "MANAGER",
  "RECEPTIONIST",
  "TEACHER",
];

export function isCenterStaffRole(role: TenantRole): role is Role {
  return (CENTER_STAFF_ROLES as readonly string[]).includes(role);
}
