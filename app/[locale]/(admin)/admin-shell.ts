import { cookies } from "next/headers";

import { PLATFORM_BRAND, shellUser, type ShellFrame } from "@/components/shell/from-context";
import { shellExperiences } from "@/components/shell/experience-switcher-data";
import { navForExperience } from "@/components/shell/nav";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { unreadNotificationCount } from "@/lib/notifications/reach";
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

  // W1: the bell's count — the admin's own notices (none are produced for them in v1).
  const [unreadNotifications, experiences] = await Promise.all([
    unreadNotificationCount(user.id),
    // W5: the role switcher.
    shellExperiences(user.id, "admin"),
  ]);

  return {
    props: {
      experience: "admin",
      nav: navForExperience("admin", "PLATFORM_ADMIN"),
      brand: PLATFORM_BRAND,
      user: shellUser(user, "PLATFORM_ADMIN"),
      experiences,
      defaultCollapsed,
      unreadNotifications,
    },
  };
}
