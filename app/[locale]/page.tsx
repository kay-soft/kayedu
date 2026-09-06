import { getLocale } from "next-intl/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getActiveCenterId } from "@/lib/auth/active-center";
import { getUserCenterRelations, primaryRole } from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, homePathForRole } from "@/lib/routes";

/**
 * Entry point: send everyone to the surface they belong in
 * (docs/02 §3 — resolve identity → memberships → center → role).
 */
export default async function HomePage() {
  const locale = await getLocale();
  const user = await getCurrentUser();

  if (!user) redirect({ href: ROUTES.login, locale });

  const relations = await getUserCenterRelations(user!.id);

  if (relations.length === 0) {
    redirect({
      href: user!.isPlatformAdmin ? ROUTES.adminCenters : ROUTES.selectCenter,
      locale,
    });
  }

  const activeCenterId = await getActiveCenterId();
  const relation =
    relations.find((item) => item.center.id === activeCenterId) ??
    (relations.length === 1 ? relations[0] : null);

  if (!relation) redirect({ href: ROUTES.selectCenter, locale });

  redirect({ href: homePathForRole(primaryRole(relation!)), locale });
}
