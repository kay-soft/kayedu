import type { ReactNode } from "react";
import { cookies } from "next/headers";

import { AppShell } from "@/components/shell/app-shell";
import { brandFromContext, shellUser } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { getUserCenterRelations, requireExperience } from "@/lib/auth/tenant";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/**
 * Role gate for the center ERP: OWNER / MANAGER / RECEPTIONIST only.
 * requireExperience() redirects anyone else to their own home.
 */
export default async function CenterLayout({
  children,
}: {
  children: ReactNode;
}) {
  const ctx = await requireExperience("center");
  const [relations, defaultCollapsed] = await Promise.all([
    getUserCenterRelations(ctx.user.id),
    cookies().then((store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1"),
  ]);

  return (
    <AppShell
      nav={navForExperience("center", ctx.role, ctx.grants)}
      brand={brandFromContext(ctx)}
      user={shellUser(ctx.user, ctx.role)}
      canSwitchCenter={relations.length > 1}
      defaultCollapsed={defaultCollapsed}
    >
      {children}
    </AppShell>
  );
}
