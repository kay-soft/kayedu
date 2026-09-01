import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { brandFromContext, shellUser } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { getUserCenterRelations, requireExperience } from "@/lib/auth/tenant";

/** Role gate: a StudentProfile at the active center. */
export default async function StudentLayout({
  children,
}: {
  children: ReactNode;
}) {
  const ctx = await requireExperience("student");
  const relations = await getUserCenterRelations(ctx.user.id);

  return (
    <AppShell
      nav={navForExperience("student", ctx.role, ctx.grants)}
      brand={brandFromContext(ctx)}
      user={shellUser(ctx.user, ctx.role)}
      canSwitchCenter={relations.length > 1}
    >
      {children}
    </AppShell>
  );
}
