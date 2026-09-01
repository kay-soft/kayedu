import type { TenantRole } from "@/lib/auth/permissions";

/**
 * Locale-less pathnames. Always navigate with the next-intl `Link`/`redirect`
 * from lib/i18n/navigation, which prefixes the active locale.
 *
 * Route groups don't add URL segments, so the four experiences are separated by
 * an explicit path prefix (the center ERP owns the root — see docs/02 §2).
 */
export const ROUTES = {
  login: "/login",
  register: "/register",
  selectCenter: "/select-center",
  invite: (token: string) => `/invite/${token}`,
  centerDashboard: "/dashboard",
  // Center configuration (M2). The settings shell lives at /settings and every
  // configuration screen is a child of it.
  centerSettings: "/settings",
  centerSettingsBranches: "/settings/branches",
  centerSettingsRooms: "/settings/rooms",
  centerSettingsEducationSystems: "/settings/education-systems",
  centerSettingsGrades: "/settings/grades",
  centerSettingsSubjects: "/settings/subjects",
  centerSettingsCard: "/settings/card",
  centerSettingsPermissions: "/settings/permissions",
  centerStaff: "/settings/staff",
  teacherDashboard: "/teacher/dashboard",
  studentSchedule: "/student/schedule",
  adminCenters: "/admin/centers",
} as const;

export function homePathForRole(role: TenantRole): string {
  switch (role) {
    case "OWNER":
    case "MANAGER":
    case "RECEPTIONIST":
      return ROUTES.centerDashboard;
    case "TEACHER":
      return ROUTES.teacherDashboard;
    case "STUDENT":
      return ROUTES.studentSchedule;
    case "PLATFORM_ADMIN":
      return ROUTES.adminCenters;
  }
}

/** Guards against open redirects on `?next=`. */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}
