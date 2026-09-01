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
  { href: "/reception", labelKey: "reception", icon: "reception", permission: "reception.use", disabled: true },
  { href: "/sessions", labelKey: "sessions", icon: "sessions", disabled: true },
  { href: "/classes", labelKey: "classes", icon: "classes", permission: "class.manage", disabled: true },
  { href: "/students", labelKey: "students", icon: "students", permission: "student.manage", disabled: true },
  { href: "/teachers", labelKey: "teachers", icon: "teachers", permission: "teacher.manage", disabled: true },
  { href: "/analytics", labelKey: "analytics", icon: "analytics", permission: "analytics.center.view", disabled: true },
  { href: "/expenses", labelKey: "expenses", icon: "expenses", permission: "expense.manage", disabled: true },
  { href: "/approvals", labelKey: "approvals", icon: "approvals", permission: "approvals.manage", disabled: true },
  { href: ROUTES.centerStaff, labelKey: "staff", icon: "settings", permission: "staff.invite" },
];

const TEACHER_NAV: NavDef[] = [
  { href: ROUTES.teacherDashboard, labelKey: "dashboard", icon: "dashboard" },
  { href: "/teacher/sessions", labelKey: "sessions", icon: "sessions", disabled: true },
  { href: "/teacher/students", labelKey: "students", icon: "students", disabled: true },
  { href: "/teacher/classes", labelKey: "classes", icon: "classes", disabled: true },
  { href: "/teacher/analytics", labelKey: "analytics", icon: "analytics", disabled: true },
];

const STUDENT_NAV: NavDef[] = [
  { href: ROUTES.studentSchedule, labelKey: "schedule", icon: "schedule" },
  { href: "/student/discover", labelKey: "discover", icon: "discover", disabled: true },
  { href: "/student/reservations", labelKey: "reservations", icon: "sessions", disabled: true },
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
