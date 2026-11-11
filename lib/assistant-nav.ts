// Relative imports on purpose — `npm run check:assistants` asserts the nav per
// preset outside the Next.js runtime.
import type { ShellNavItem } from "../components/shell/nav.ts";
import type { AssistantPermission } from "./assistant-catalog.ts";
import { ASSISTANT_WORKSPACE_KEYS, assistantCan, type AssistantActing } from "./db/assistant-acting.ts";
import { ROUTES } from "./routes.ts";

/**
 * The assistant shell's nav (W7b, D-W37; docs/04 §11.36) — dynamic per
 * permission: Home, then each working page only when `assistantCan` grants its
 * key at one or more of the teacher's branches that allow assistants — or, from
 * W8d (D-W41 items 9, 10), in one of the teacher's workspaces. Never a centre
 * nav item, never settlements, money records, the teacher's account or premium.
 */
type Page = {
  /** Shown when `assistantCan` grants any of these somewhere. */
  keys: readonly AssistantPermission[];
  /** Where the keys count: the teacher's branches, their workspaces, or both. */
  where: "branches" | "workspaces" | "both";
  labelKey: string;
  icon: ShellNavItem["icon"];
  href: (teacherUserId: string) => string;
};

const PAGES: Page[] = [
  // W9 (D-W42 item 9): the teacher's exams and homework — at a branch or in a workspace.
  { keys: ["assessments.review"], where: "both", labelKey: "assessments", icon: "assessments", href: ROUTES.assistantAssessments },
  { keys: ["classes.view"], where: "branches", labelKey: "classes", icon: "classes", href: ROUTES.assistantClasses },
  // W8d: the teacher's workspaces — to read their classes, or to act on their sessions.
  { keys: ASSISTANT_WORKSPACE_KEYS, where: "workspaces", labelKey: "workspaces", icon: "workspaces", href: ROUTES.assistantWorkspaces },
  { keys: ["requests.manage"], where: "branches", labelKey: "requests", icon: "approvals", href: ROUTES.assistantRequests },
  { keys: ["analytics.view"], where: "branches", labelKey: "overview", icon: "analytics", href: ROUTES.assistantOverview },
  // W8d (D-W41 item 9): the teacher's Earnings, Full only — at a branch or in a workspace.
  { keys: ["analytics.view"], where: "both", labelKey: "earnings", icon: "earnings", href: ROUTES.assistantEarnings },
];

export function assistantNavItems(
  teacherUserId: string,
  acting: Pick<AssistantActing, "grants" | "branches"> & Partial<Pick<AssistantActing, "workspaces">>,
): ShellNavItem[] {
  const resolved = { ...acting, teacherUserId };
  const centres = (where: Page["where"]) => [
    ...(where === "workspaces" ? [] : acting.branches.map((branch) => branch.centerId)),
    ...(where === "branches" ? [] : (acting.workspaces ?? []).map((workspace) => workspace.centerId)),
  ];
  const granted = (page: Page) => centres(page.where).some((centerId) => page.keys.some((key) => assistantCan(resolved, key, centerId)));
  return [
    { href: ROUTES.assistantHome(teacherUserId), labelKey: "home", icon: "dashboard" },
    ...PAGES.filter(granted).map((page) => ({
      href: page.href(teacherUserId),
      labelKey: page.labelKey,
      icon: page.icon,
    })),
  ];
}
