import { cookies } from "next/headers";

import {
  PLATFORM_BRAND,
  brandFromContext,
  shellScope,
  shellUser,
  type ShellFrame,
} from "@/components/shell/from-context";
import { shellExperiences } from "@/components/shell/experience-switcher-data";
import { teacherNavAcross, withPendingCount } from "@/components/shell/nav";
import { getPendingTeacherApprovalCounts } from "@/lib/auth/approval-counts";
import { ctxCan, requireTeacherUser } from "@/lib/auth/tenant";
import { getTeacherScope } from "@/lib/auth/teacher-scope";
import { unreadNotificationCount } from "@/lib/notifications/reach";
import { ROUTES } from "@/lib/routes";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/**
 * The teacher portal's shell (F2: shared by `(teacher)/layout.tsx` and
 * Account settings). Role gate: a TEACHER role at some branch — except a
 * teacher with **zero** centres, who gets a minimal shell around the centre
 * directory (`/teacher/centers`, M15) under the platform default brand.
 * `requireTeacherUser()` never redirects a zero-relation user away, unlike
 * `requireExperience("teacher")` — see its doc comment (`lib/auth/tenant.ts`)
 * for why that matters here.
 *
 * W8a (D-W38 item 11): a teacher with no branch but a PERSONAL workspace gets
 * the same minimal shell with Workspaces first (their landing), Earnings
 * (W8d — their workspaces' money), Assistants (W8d: an assistant works in
 * their workspaces too) and the centre directory.
 * A teacher with neither keeps the directory alone (M15, unchanged); with
 * premium, the directory links to Workspaces to create the first one.
 * Workspaces never join the branch scope.
 *
 * U7: the portal reads **All branches** by default (`getTeacherScope`). The
 * nav shows an item when any branch in view would show it, the Approvals
 * badge sums the branches that let this teacher act, and the header switcher
 * offers All branches above each branch. Under All branches the shell carries
 * the platform brand — no one branch's name stands for all of them.
 */
export async function teacherShell(): Promise<ShellFrame> {
  const session = await requireTeacherUser();
  const [defaultCollapsed, unreadNotifications, experiences] = await Promise.all([
    cookies().then((store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1"),
    // W1: the bell's count.
    unreadNotificationCount(session.user.id),
    // W5: the role switcher.
    shellExperiences(session.user.id, "teacher"),
  ]);

  if (!session.hasCenter) {
    return {
      props: {
        experience: "teacher",
        nav: session.workspaceOnly
          ? [
              { href: ROUTES.teacherWorkspaces, labelKey: "workspaces", icon: "workspaces" },
              // W8d (D-W41): a workspace-only teacher's Earnings — their workspaces only.
              { href: ROUTES.teacherEarnings, labelKey: "earnings", icon: "earnings" },
              { href: ROUTES.teacherAssistants, labelKey: "assistants", icon: "assistants" },
              { href: ROUTES.teacherCenters, labelKey: "centers", icon: "centers" },
            ]
          : [{ href: ROUTES.teacherCenters, labelKey: "centers", icon: "centers" }],
        brand: PLATFORM_BRAND,
        user: shellUser(session.user, "TEACHER"),
        experiences,
        defaultCollapsed,
        unreadNotifications,
      },
    };
  }

  const scope = await getTeacherScope();
  // F7 — the teacher's own count: only their classes, only where they may act.
  const approvalCounts = await Promise.all(
    scope.inView
      .filter((ctx) => ctxCan(ctx, "reservation.manage.own"))
      .map((ctx) => getPendingTeacherApprovalCounts(ctx)),
  );
  const pending = approvalCounts.reduce((sum, counts) => sum + counts.total, 0);
  const teacherRelations = session.relations.filter((relation) => relation.roles.includes("TEACHER"));
  return {
    props: {
      experience: "teacher",
      nav: withPendingCount(
        teacherNavAcross(scope.inView.map((ctx) => ({ role: ctx.role, grants: ctx.grants }))),
        ROUTES.teacherApprovals,
        pending,
      ),
      brand: scope.selected ? brandFromContext(scope.selected) : PLATFORM_BRAND,
      user: shellUser(scope.user, "TEACHER"),
      scope: { ...shellScope(teacherRelations, [], scope.selected?.center.id ?? null), mode: "teacher" },
      experiences,
      defaultCollapsed,
      unreadNotifications,
    },
  };
}
