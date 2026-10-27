import { cookies } from "next/headers";

import {
  PLATFORM_BRAND,
  brandFromContext,
  shellScope,
  shellUser,
  type ShellFrame,
} from "@/components/shell/from-context";
import { navForExperience, withPendingCount } from "@/components/shell/nav";
import { getPendingTeacherApprovalCounts } from "@/lib/auth/approval-counts";
import { ctxCan, requireTeacherUser } from "@/lib/auth/tenant";
import { ROUTES } from "@/lib/routes";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/**
 * The teacher portal's shell (F2: shared by `(teacher)/layout.tsx` and
 * Account settings). Role gate: a TEACHER membership at the active center —
 * except a teacher with **zero** centres, who gets a minimal shell around the
 * centre directory (`/teacher/centers`, M15) under the platform default
 * brand. `requireTeacherUser()` never redirects a zero-relation user away,
 * unlike `requireExperience("teacher")` — see its doc comment
 * (`lib/auth/tenant.ts`) for why that matters here.
 */
export async function teacherShell(): Promise<ShellFrame> {
  const session = await requireTeacherUser();
  const defaultCollapsed = await cookies().then(
    (store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1",
  );

  if (!session.hasCenter) {
    return {
      props: {
        experience: "teacher",
        nav: [{ href: ROUTES.teacherCenters, labelKey: "centers", icon: "centers" }],
        brand: PLATFORM_BRAND,
        user: shellUser(session.user, "TEACHER"),
        defaultCollapsed,
      },
    };
  }

  const { ctx } = session;
  // F7 — the teacher's own count: only their classes, only if they may act.
  const approvalCounts = ctxCan(ctx, "reservation.manage.own")
    ? await getPendingTeacherApprovalCounts(ctx)
    : null;
  return {
    props: {
      experience: "teacher",
      nav: withPendingCount(
        navForExperience("teacher", ctx.role, ctx.grants),
        ROUTES.teacherApprovals,
        approvalCounts?.total,
      ),
      brand: brandFromContext(ctx),
      user: shellUser(ctx.user, ctx.role),
      scope: shellScope(session.relations, [], ctx.center.id),
      defaultCollapsed,
    },
  };
}
