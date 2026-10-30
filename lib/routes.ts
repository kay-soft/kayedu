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
  /** Account settings (F2): every signed-in person, inside the shell they came from. */
  account: "/account",
  /** Where Supabase's confirmation link lands (SEC-66). */
  authConfirm: "/auth/confirm",
  selectCenter: "/select-center",
  /**
   * F3: a parent accepts a code here. The code travels in the URL fragment
   * (`#XXXXXXXX`, `familyJoinUrl`) — read client-side and posted, never a
   * query parameter, so it never reaches a server or proxy log.
   */
  familyJoin: "/family/join",
  invite: (token: string) => `/invite/${token}`,
  // F5: the public Explore pages — guests, no sign-in (`(public)` route group).
  explore: "/explore",
  exploreBranch: (slug: string) => `/explore/${encodeURIComponent(slug)}`,
  exploreClass: (slug: string, classId: string) =>
    `/explore/${encodeURIComponent(slug)}/classes/${encodeURIComponent(classId)}`,
  exploreTeacher: (slug: string, teacherUserId: string) =>
    `/explore/${encodeURIComponent(slug)}/teachers/${encodeURIComponent(teacherUserId)}`,
  centerDashboard: "/dashboard",
  // People (M3). The print views live under the student they belong to.
  centerTeachers: "/teachers",
  centerTeacher: (id: string) => `/teachers/${id}`,
  centerStudents: "/students",
  centerStudent: (id: string) => `/students/${id}`,
  // F4: the previewable, undoable bulk grade promotion (`student.promote`).
  centerStudentsPromote: "/students/promote",
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
  // F8: the branch logo.
  centerSettingsBranding: "/settings/branding",
  centerSettingsPermissions: "/settings/permissions",
  // F1: the organization's branches and an Owner's Add branch.
  centerSettingsBranches: "/settings/branches",
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
  // F5: a Discover class, on the same class page component Explore uses.
  studentDiscoverClass: (centerId: string, classId: string) =>
    `/student/discover/${encodeURIComponent(centerId)}/${encodeURIComponent(classId)}`,
  studentReservations: "/student/reservations",
  studentProfile: "/student/profile",
  // F4: "Your studies" — a new student's grade, then an optional parent invite.
  studentOnboarding: "/student/onboarding",
  parentHome: "/parent",
  adminCenters: "/admin/centers",
  adminCenter: (id: string) => `/admin/centers/${id}`,
  // F1: reached from a button on /admin/centers, not from the sidebar.
  adminOrganizations: "/admin/organizations",
  adminOrganization: (id: string) => `/admin/organizations/${id}`,
  adminPlatform: "/admin/platform",
  adminCatalog: "/admin/catalog",
} as const;

/**
 * Where a Supabase confirmation link should land (SEC-66) — sign-up's and
 * Account settings' email change (F2) alike. Undefined without
 * NEXT_PUBLIC_APP_URL: Supabase then falls back to its Site URL.
 */
export function authConfirmUrl(locale: "ar" | "en"): string | undefined {
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  return origin ? `${origin.replace(/\/+$/, "")}/${locale}${ROUTES.authConfirm}` : undefined;
}

/**
 * The join link a code is shared with (F3): `<origin>/<locale>/family/join#CODE`.
 * The fragment never leaves the browser; the page reads it and posts it.
 */
export function familyJoinUrl(origin: string, locale: "ar" | "en", code: string): string {
  return `${origin.replace(/\/+$/, "")}/${locale}${ROUTES.familyJoin}#${code}`;
}

/** The signed-in experiences, each with its own shell (docs/02 §2). */
export const SHELL_EXPERIENCES = ["center", "teacher", "student", "parent", "admin"] as const;
export type ShellExperience = (typeof SHELL_EXPERIENCES)[number];

/**
 * U1: Account settings opened from the branch hub (`/select-center`), where no
 * branch is active — rendered in a neutral hub shell (header + user menu, no
 * branch sidebar), whose back link returns to the hub. Not a `ShellExperience`:
 * it has no nav, no branch scope and no tenant context.
 */
export const ACCOUNT_HUB_HINT = "hub";
export type AccountOrigin = ShellExperience | typeof ACCOUNT_HUB_HINT;

/**
 * Account settings, asked for from inside `experience` (F2) — the page renders
 * that experience's shell. Only a hint: the page re-checks it server-side.
 */
export function accountPath(experience: AccountOrigin): string {
  return `${ROUTES.account}?from=${experience}`;
}

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
