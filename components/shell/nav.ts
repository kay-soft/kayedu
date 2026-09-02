import type { TenantRole } from "@/lib/auth/permissions";
import { can } from "@/lib/auth/permissions";
import type { PermissionGrants, Permission } from "@/lib/auth/permissions";
import { ROUTES } from "@/lib/routes";

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
  | "discover"
  | "centers"
  | "platform";

export type ShellNavItem = {
  href: string;
  /** Key under the `Nav` namespace in messages/*.json. */
  labelKey: string;
  icon: ShellIconName;
  /** Marks routes that land in a later milestone. */
  disabled?: boolean;
};

type NavDef = ShellNavItem & { permission?: Permission };

const CENTER_NAV: NavDef[] = [
  { href: ROUTES.centerDashboard, labelKey: "dashboard", icon: "dashboard" },
  { href: ROUTES.centerReception, labelKey: "reception", icon: "reception", permission: "reception.use" },
  { href: ROUTES.centerSessions, labelKey: "sessions", icon: "sessions", permission: "session.view" },
  { href: ROUTES.centerClasses, labelKey: "classes", icon: "classes", permission: "class.manage" },
  { href: ROUTES.centerStudents, labelKey: "students", icon: "students", permission: "student.manage" },
  { href: ROUTES.centerTeachers, labelKey: "teachers", icon: "teachers", permission: "teacher.manage" },
  { href: ROUTES.centerAnalytics, labelKey: "analytics", icon: "analytics", permission: "analytics.center.view" },
  { href: ROUTES.centerExpenses, labelKey: "expenses", icon: "expenses", permission: "expense.manage" },
  { href: "/approvals", labelKey: "approvals", icon: "approvals", permission: "approvals.manage", disabled: true },
  // Settings owns its own sub-navigation (users & roles lives under it).
  { href: ROUTES.centerSettings, labelKey: "settings", icon: "settings", permission: "center.settings.edit" },
];

const TEACHER_NAV: NavDef[] = [
  { href: ROUTES.teacherDashboard, labelKey: "dashboard", icon: "dashboard" },
  { href: ROUTES.teacherSessions, labelKey: "sessions", icon: "sessions" },
  { href: ROUTES.teacherStudents, labelKey: "students", icon: "students" },
  { href: ROUTES.teacherClasses, labelKey: "classes", icon: "classes" },
  // Spec §4.2 item 1's filterable earnings/sessions/students analytics screen
  // is still a gap beyond the Dashboard's combined/per-center summary (M7) —
  // docs/03-build-order.md M7 note.
  { href: "/teacher/analytics", labelKey: "analytics", icon: "analytics", disabled: true },
];

const STUDENT_NAV: NavDef[] = [
  { href: ROUTES.studentSchedule, labelKey: "schedule", icon: "schedule" },
  { href: ROUTES.studentDiscover, labelKey: "discover", icon: "discover" },
  { href: ROUTES.studentReservations, labelKey: "reservations", icon: "sessions" },
];

const ADMIN_NAV: NavDef[] = [
  { href: ROUTES.adminCenters, labelKey: "centers", icon: "centers" },
  { href: "/admin/platform", labelKey: "platform", icon: "platform", disabled: true },
];

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
      disabled: item.disabled,
    }));
}

export function navForExperience(
  experience: "center" | "teacher" | "student" | "admin",
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
    case "admin":
      return visible(ADMIN_NAV, role, grants);
  }
}
