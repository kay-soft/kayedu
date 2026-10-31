// Relative imports on purpose (P1): `scripts/diagnose-nav.ts`, `seed:verify`
// and `check:permissions` compute the nav a role would see through THIS file —
// the same function the shell calls — outside the Next.js runtime, where the
// `@/` alias does not resolve. (Same discipline as lib/db/*.)
import type { TenantRole, PermissionGrants, Permission } from "../../lib/auth/permissions.ts";
import { can } from "../../lib/auth/permissions.ts";
import { ROUTES, type ShellExperience } from "../../lib/routes.ts";

/**
 * Icon names are passed as strings so the nav stays serializable across the
 * server/client boundary; the client maps them in shell-icon.tsx.
 */
export type ShellIconName =
  | "dashboard"
  | "reception"
  | "sessions"
  | "classes"
  | "students"
  | "teachers"
  | "analytics"
  | "expenses"
  | "approvals"
  | "settings"
  | "schedule"
  | "calendar"
  | "discover"
  | "centers"
  | "platform"
  | "catalog"
  | "refunds"
  | "settlements"
  | "audit";

export type ShellNavItem = {
  href: string;
  /** Key under the `Nav` namespace in messages/*.json. */
  labelKey: string;
  icon: ShellIconName;
  /**
   * Key under the `NavGroups` namespace. Consecutive items sharing a group sit
   * under one small heading (docs/04 §5 "Sidebar"); an item with no group is
   * drawn without one. A route a later milestone owns has no entry here at all
   * — the nav never shows a link a centre cannot use.
   */
  group?: string;
  /**
   * How many requests wait behind this item (F7) — the Approvals badge. Set by
   * the shell frames after `navForExperience`, never by the nav definition
   * itself: it is a per-request fact (and only for someone who can act on it),
   * not part of what a role may see.
   */
  pendingCount?: number;
};

/**
 * A nav item and the permission that shows it. **The page's own gate is the
 * authority** (P1, docs/02-architecture.md §6.2): an item's `permission` must
 * be exactly the action its page asserts with `requirePermission`, no more and
 * no less — an item broader than its page is a link that bounces the user
 * home, one narrower hides a page they may open. `check:permissions` reads each
 * page file and compares, so the two cannot drift apart silently.
 */
export type NavDef = ShellNavItem & { permission?: Permission };

export const CENTER_NAV: NavDef[] = [
  { href: ROUTES.centerDashboard, labelKey: "dashboard", icon: "dashboard" },
  { href: ROUTES.centerReception, labelKey: "reception", icon: "reception", permission: "reception.use", group: "frontDesk" },
  { href: ROUTES.centerSessions, labelKey: "sessions", icon: "sessions", permission: "session.view", group: "frontDesk" },
  { href: ROUTES.centerApprovals, labelKey: "approvals", icon: "approvals", permission: "approvals.manage", group: "frontDesk" },
  { href: ROUTES.centerClasses, labelKey: "classes", icon: "classes", permission: "class.manage", group: "academics" },
  { href: ROUTES.centerStudents, labelKey: "students", icon: "students", permission: "student.manage", group: "academics" },
  { href: ROUTES.centerTeachers, labelKey: "teachers", icon: "teachers", permission: "teacher.manage", group: "academics" },
  { href: ROUTES.centerAnalytics, labelKey: "analytics", icon: "analytics", permission: "analytics.center.view", group: "money" },
  { href: ROUTES.centerExpenses, labelKey: "expenses", icon: "expenses", permission: "expense.manage", group: "money" },
  { href: ROUTES.centerRefunds, labelKey: "refunds", icon: "refunds", permission: "payment.refund", group: "money" },
  { href: ROUTES.centerSettlements, labelKey: "settlements", icon: "settlements", permission: "settlement.manage", group: "money" },
  // SEC-2c: the audit trail (SEC-07) — the page asserts `audit.view`.
  { href: ROUTES.centerAudit, labelKey: "audit", icon: "audit", permission: "audit.view", group: "money" },
  // Settings owns its own sub-navigation (users & roles lives under it).
  { href: ROUTES.centerSettings, labelKey: "settings", icon: "settings", permission: "center.settings.edit" },
];

export const TEACHER_NAV: NavDef[] = [
  { href: ROUTES.teacherDashboard, labelKey: "dashboard", icon: "dashboard" },
  { href: ROUTES.teacherSessions, labelKey: "sessions", icon: "sessions" },
  // U7: the month calendar of the teacher's own sessions.
  { href: ROUTES.teacherCalendar, labelKey: "calendar", icon: "calendar" },
  { href: ROUTES.teacherStudents, labelKey: "students", icon: "students" },
  // P1: the classes page asserts `changeRequest.create` (it is the request
  // form's page); the item used to carry no permission, so a teacher without
  // it saw a link that redirected them home.
  {
    href: ROUTES.teacherClasses,
    labelKey: "classes",
    icon: "classes",
    permission: "changeRequest.create",
  },
  {
    href: ROUTES.teacherApprovals,
    labelKey: "approvals",
    icon: "approvals",
    permission: "reservation.manage.own",
  },
  // Spec §4.2 item 1's filterable earnings/sessions/students analytics screen
  // is still a gap beyond the Dashboard's combined/per-center summary (M7) —
  // docs/03-build-order.md M7 note. R10a removed its "Soon" nav placeholder:
  // the nav lists only what a role can open. Add the item back with the screen.
  { href: ROUTES.teacherSettlements, labelKey: "settlements", icon: "settlements" },
];

const STUDENT_NAV: NavDef[] = [
  { href: ROUTES.studentSchedule, labelKey: "schedule", icon: "schedule" },
  { href: ROUTES.studentCalendar, labelKey: "calendar", icon: "calendar" },
  { href: ROUTES.studentDiscover, labelKey: "discover", icon: "discover" },
  { href: ROUTES.studentReservations, labelKey: "reservations", icon: "sessions" },
];

// The parent portal is a read-only mirror of the student schedule (M16, spec
// §4.5) and, since U7, its calendar — per selected child. No permission gate:
// a parent's `can()` is unconditionally false (lib/auth/permissions.ts), so
// there is nothing this nav needs to hide.
const PARENT_NAV: NavDef[] = [
  { href: ROUTES.parentHome, labelKey: "schedule", icon: "schedule" },
  { href: ROUTES.parentCalendar, labelKey: "calendar", icon: "calendar" },
];

const ADMIN_NAV: NavDef[] = [
  { href: ROUTES.adminCenters, labelKey: "centers", icon: "centers" },
  { href: ROUTES.adminPlatform, labelKey: "platform", icon: "platform" },
  { href: ROUTES.adminCatalog, labelKey: "catalog", icon: "catalog" },
];

/**
 * Puts a pending count on the nav item at `href` (F7). A zero or absent count
 * leaves the item untouched, so a role that cannot act — or has nothing
 * waiting — gets exactly the nav it had.
 */
export function withPendingCount(
  nav: ShellNavItem[],
  href: string,
  count: number | null | undefined,
): ShellNavItem[] {
  if (!count || count < 1) return nav;
  return nav.map((item) => (item.href === href ? { ...item, pendingCount: count } : item));
}

function visible(
  items: NavDef[],
  role: TenantRole,
  grants?: PermissionGrants,
): ShellNavItem[] {
  return items
    .filter((item) => !item.permission || can(role, item.permission, grants))
    .map((item) => ({
      href: item.href,
      labelKey: item.labelKey,
      icon: item.icon,
      group: item.group,
    }));
}

/**
 * The teacher nav under All branches (U7): an item shows when **any** branch
 * in view would show it — each branch's own grants, never a merged grant set —
 * in `TEACHER_NAV`'s order. A page reached this way still gates on the
 * branches that grant it (`firstGranting`), and each row on its own branch.
 */
export function teacherNavAcross(
  grantsByBranch: { role: TenantRole; grants?: PermissionGrants }[],
): ShellNavItem[] {
  const shown = new Set(
    grantsByBranch.flatMap(({ role, grants }) => visible(TEACHER_NAV, role, grants).map((item) => item.href)),
  );
  return TEACHER_NAV.filter((item) => shown.has(item.href)).map((item) => ({
    href: item.href,
    labelKey: item.labelKey,
    icon: item.icon,
    group: item.group,
  }));
}

export function navForExperience(
  experience: ShellExperience,
  role: TenantRole,
  grants?: PermissionGrants,
): ShellNavItem[] {
  switch (experience) {
    case "center":
      return visible(CENTER_NAV, role, grants);
    case "teacher":
      return visible(TEACHER_NAV, role, grants);
    case "student":
      return visible(STUDENT_NAV, role, grants);
    case "parent":
      return visible(PARENT_NAV, role, grants);
    case "admin":
      return visible(ADMIN_NAV, role, grants);
  }
}
