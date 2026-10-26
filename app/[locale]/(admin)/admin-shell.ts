import { cookies } from "next/headers";

import { PLATFORM_BRAND, shellUser, type ShellFrame } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/**
 * The platform admin's shell (F2: shared by `(admin)/layout.tsx` and Account
 * settings). Deliberately has no tenant context — a super admin operates
 * across centers and never browses tenant data casually (spec §4.4).
 */
export async function adminShell(): Promise<ShellFrame> {
  const [user, defaultCollapsed] = await Promise.all([
    requirePlatformAdmin(),
    cookies().then((store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1"),
  ]);

  return {
    props: {
      experience: "admin",
      nav: navForExperience("admin", "PLATFORM_ADMIN"),
      brand: PLATFORM_BRAND,
      user: shellUser(user, "PLATFORM_ADMIN"),
      defaultCollapsed,
    },
  };
}
