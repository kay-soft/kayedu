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
  /** A login with no app user yet: a pending claim or an unconfirmed email (SEC-2a). */
  accountPending: "/account-pending",
  /** Where Supabase's confirmation link lands (SEC-66). */
  authConfirm: "/auth/confirm",
  selectCenter: "/select-center",
  invite: (token: string) => `/invite/${token}`,
  centerDashboard: "/dashboard",
  // People (M3). The print views live under the student they belong to.
  centerTeachers: "/teachers",
  centerTeacher: (id: string) => `/teachers/${id}`,
  centerStudents: "/students",
  centerStudent: (id: string) => `/students/${id}`,
  centerStudentCard: (id: string) => `/students/${id}/card`,
  centerStudentPaper: (id: string) => `/students/${id}/paper`,
  // Classes, schedules & enrollment (M4).
  centerClasses: "/classes",
  centerClass: (id: string) => `/classes/${id}`,
  // The daily loop: sessions, attendance & payments (M5).
  centerSessions: "/sessions",
  centerSession: (id: string) => `/sessions/${id}`,
  centerSessionPrint: (id: string) => `/sessions/${id}/print`,
  centerReception: "/reception",
  // Analytics & expenses (M6).
  centerAnalytics: "/analytics",
  centerExpenses: "/expenses",
  centerApprovals: "/approvals",
  centerRefunds: "/refunds",
  centerSettlements: "/settlements",
  // SEC-2b (D-06): the centre audit trail — voids, absent switches, refunds,
  // settlement transitions, price/cut changes, unpaid check-ins.
  centerAudit: "/audit",
  // Center configuration (M2). The settings shell lives at /settings and every
  // configuration screen is a child of it.
  centerSettings: "/settings",
  centerSettingsRooms: "/settings/rooms",
  centerSettingsPaymentMethods: "/settings/payment-methods",
  centerSettingsTerms: "/settings/terms",
  centerSettingsCatalog: "/settings/catalog",
  centerSettingsCard: "/settings/card",
  centerSettingsPermissions: "/settings/permissions",
  centerStaff: "/settings/staff",
  teacherDashboard: "/teacher/dashboard",
  teacherSessions: "/teacher/sessions",
  teacherSession: (id: string) => `/teacher/sessions/${id}`,
  teacherSessionPrint: (id: string) => `/teacher/sessions/${id}/print`,
  teacherStudents: "/teacher/students",
  teacherStudent: (id: string) => `/teacher/students/${id}`,
  teacherClasses: "/teacher/classes",
  teacherApprovals: "/teacher/approvals",
  teacherCenters: "/teacher/centers",
  teacherSettlements: "/teacher/settlements",
  studentSchedule: "/student/schedule",
  studentDiscover: "/student/discover",
  studentReservations: "/student/reservations",
  studentProfile: "/student/profile",
  parentHome: "/parent",
  adminCenters: "/admin/centers",
  adminCenter: (id: string) => `/admin/centers/${id}`,
  adminPlatform: "/admin/platform",
  adminCatalog: "/admin/catalog",
} as const;

export function homePathForRole(role: TenantRole): string {
  switch (role) {
    case "OWNER":
    case "MANAGER":
    case "RECEPTIONIST":
    case "ACCOUNTANT":
      return ROUTES.centerDashboard;
    case "TEACHER":
      return ROUTES.teacherDashboard;
    case "STUDENT":
      return ROUTES.studentSchedule;
    case "PARENT":
      return ROUTES.parentHome;
    case "PLATFORM_ADMIN":
      return ROUTES.adminCenters;
  }
}

/**
 * Guards against open redirects on `?next=` (SEC-43): a same-origin,
 * root-relative path only. Refuses a protocol-relative `//host`, any
 * backslash (browsers treat `/\host` as `//host`), control characters and
 * anything that resolves to another origin, and caps the length.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || [...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
    return null;
  }
  try {
    const base = "https://kayedu.invalid";
    const resolved = new URL(value, base);
    if (resolved.origin !== base) return null;
  } catch {
    return null;
  }
  return value;
}
