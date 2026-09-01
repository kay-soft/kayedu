import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { brandFromContext, shellUser } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { getUserCenterRelations, requireExperience } from "@/lib/auth/tenant";

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
  const relations = await getUserCenterRelations(ctx.user.id);

  return (
    <AppShell
      nav={navForExperience("center", ctx.role, ctx.grants)}
      brand={brandFromContext(ctx)}
      user={shellUser(ctx.user, ctx.role)}
      canSwitchCenter={relations.length > 1}
    >
      {children}
    </AppShell>
  );
}
