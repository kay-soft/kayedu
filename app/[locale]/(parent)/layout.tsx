import type { ReactNode } from "react";
import { cookies } from "next/headers";

import { AppShell } from "@/components/shell/app-shell";
import { shellUser } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { requireParentUser } from "@/lib/auth/tenant";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/** The platform default — a parent has no "home" branch of their own (M16). */
const PARENT_BRAND = {
  name: "KayEdu",
  logoUrl: null as string | null,
  themeColor: "#2563EB",
};

/**
 * Role gate: any signed-in `User` (M16, spec §4.5 "Parent portal") — a
 * brand-new parent account has zero VERIFIED children until OD-6's
 * still-open verification step happens, and `/parent` itself renders that as
 * an empty state (see `requireParentUser`'s doc comment, `lib/auth/tenant.ts`).
 */
export default async function ParentLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireParentUser();
  const defaultCollapsed = await cookies().then(
    (store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1",
  );

  return (
    <AppShell
      nav={navForExperience("parent", "PARENT")}
      brand={PARENT_BRAND}
      user={shellUser(session.user, "PARENT")}
      defaultCollapsed={defaultCollapsed}
    >
      {children}
    </AppShell>
  );
}
