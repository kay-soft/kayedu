import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { brandFromContext, shellUser } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { getUserCenterRelations, requireExperience } from "@/lib/auth/tenant";

/** Role gate: a TEACHER membership at the active center. */
export default async function TeacherLayout({
  children,
}: {
  children: ReactNode;
}) {
  const ctx = await requireExperience("teacher");
  const relations = await getUserCenterRelations(ctx.user.id);

  return (
    <AppShell
      nav={navForExperience("teacher", ctx.role, ctx.grants)}
      brand={brandFromContext(ctx)}
      user={shellUser(ctx.user, ctx.role)}
      canSwitchCenter={relations.length > 1}
    >
      {children}
    </AppShell>
  );
}
