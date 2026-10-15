import type { ReactNode } from "react";
import { cookies } from "next/headers";

import { AppShell } from "@/components/shell/app-shell";
import {
  brandFromContext,
  shellScope,
  shellUser,
} from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { requireTeacherUser } from "@/lib/auth/tenant";
import { ROUTES } from "@/lib/routes";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/** The platform default before a teacher has connected anywhere (mirrors docs/04 §2). */
const DEFAULT_TEACHER_BRAND = {
  name: "KayEdu",
  logoUrl: null as string | null,
  themeColor: "#2563EB",
};

/**
 * Role gate: a TEACHER membership at the active center — except a teacher
 * with **zero** centres, who gets a minimal shell around the centre
 * directory (`/teacher/centers`, M15) instead. `requireTeacherUser()` never
 * redirects a zero-relation user away, unlike `requireExperience("teacher")`
 * — see its doc comment (`lib/auth/tenant.ts`) for why that matters here.
 */
export default async function TeacherLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireTeacherUser();
  const defaultCollapsed = await cookies().then(
    (store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1",
  );

  if (!session.hasCenter) {
    return (
      <AppShell
        nav={[{ href: ROUTES.teacherCenters, labelKey: "centers", icon: "centers" }]}
        brand={DEFAULT_TEACHER_BRAND}
        user={shellUser(session.user, "TEACHER")}
        defaultCollapsed={defaultCollapsed}
      >
        {children}
      </AppShell>
    );
  }

  const { ctx } = session;
  return (
    <AppShell
      nav={navForExperience("teacher", ctx.role, ctx.grants)}
      brand={brandFromContext(ctx)}
      user={shellUser(ctx.user, ctx.role)}
      scope={shellScope(session.relations, [], ctx.center.id)}
      defaultCollapsed={defaultCollapsed}
    >
      {children}
    </AppShell>
  );
}
