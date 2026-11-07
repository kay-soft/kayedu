// Relative imports on purpose — `npm run check:assistants` asserts the nav per
// preset outside the Next.js runtime.
import type { ShellNavItem } from "../components/shell/nav.ts";
import type { AssistantPermission } from "./assistant-catalog.ts";
import { assistantCan, type AssistantActing } from "./db/assistant-acting.ts";
import { ROUTES } from "./routes.ts";

/**
 * The assistant shell's nav (W7b, D-W37; docs/04 §11.36) — dynamic per
 * permission: Home, then each working page only when `assistantCan` grants its
 * key at one or more of the teacher's branches that allow assistants. Never a
 * centre nav item, never settlements, money, the teacher's account or premium.
 */
const PAGES: { permission: AssistantPermission; labelKey: string; icon: ShellNavItem["icon"]; href: (teacherUserId: string) => string }[] = [
  { permission: "assessments.review", labelKey: "assessments", icon: "assessments", href: ROUTES.assistantAssessments },
  { permission: "classes.view", labelKey: "classes", icon: "classes", href: ROUTES.assistantClasses },
  { permission: "requests.manage", labelKey: "requests", icon: "approvals", href: ROUTES.assistantRequests },
  { permission: "analytics.view", labelKey: "overview", icon: "analytics", href: ROUTES.assistantOverview },
];

export function assistantNavItems(teacherUserId: string, acting: Pick<AssistantActing, "grants" | "branches">): ShellNavItem[] {
  const granted = (permission: AssistantPermission) => acting.branches.some((branch) => assistantCan(acting, permission, branch.centerId));
  return [
    { href: ROUTES.assistantHome(teacherUserId), labelKey: "home", icon: "dashboard" },
    ...PAGES.filter((page) => granted(page.permission)).map((page) => ({
      href: page.href(teacherUserId),
      labelKey: page.labelKey,
      icon: page.icon,
    })),
  ];
}
