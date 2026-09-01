import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { shellUser } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { requirePlatformAdmin } from "@/lib/auth/tenant";

/**
 * Platform admin. Deliberately has no tenant context — a super admin operates
 * across centers and never browses tenant data casually (spec §4.4).
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requirePlatformAdmin();

  return (
    <AppShell
      nav={navForExperience("admin", "PLATFORM_ADMIN")}
      brand={{ name: "KayEdu", logoUrl: null, themeColor: "#2563EB" }}
      user={shellUser(user, "PLATFORM_ADMIN")}
      canSwitchCenter={false}
    >
      {children}
    </AppShell>
  );
}
