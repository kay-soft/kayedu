import { cookies } from "next/headers";

import { PLATFORM_BRAND, shellUser, type ShellFrame } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { requireParentUser } from "@/lib/auth/tenant";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/**
 * The parent portal's shell (F2: shared by `(parent)/layout.tsx` and Account
 * settings), under the platform default brand — a parent has no "home"
 * branch of their own (M16). Role gate: any signed-in `User` (spec §4.5
 * "Parent portal") — a brand-new parent account has zero VERIFIED children
 * until OD-6's still-open verification step happens, and `/parent` itself
 * renders that as an empty state (see `requireParentUser`'s doc comment,
 * `lib/auth/tenant.ts`).
 */
export async function parentShell(): Promise<ShellFrame> {
  const session = await requireParentUser();
  const defaultCollapsed = await cookies().then(
    (store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1",
  );

  return {
    props: {
      experience: "parent",
      nav: navForExperience("parent", "PARENT"),
      brand: PLATFORM_BRAND,
      user: shellUser(session.user, "PARENT"),
      defaultCollapsed,
    },
  };
}
