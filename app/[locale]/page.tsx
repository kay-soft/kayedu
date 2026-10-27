import { getLocale } from "next-intl/server";

import { getAppIdentity } from "@/lib/auth/session";
import { getActiveCenterId } from "@/lib/auth/active-center";
import { getUserCenterRelations, landingWithoutBranch, primaryRole } from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, homePathForRole } from "@/lib/routes";

/**
 * Entry point: send everyone to the surface they belong in
 * (docs/02 §3 — resolve identity → memberships → center → role).
 *
 * Signed out, `/` lands on Explore (F5) — the public pages where anyone can
 * browse branches, classes and teachers; it replaced the DES landing. Every
 * signed-in path below is unchanged.
 */
export default async function HomePage() {
  const locale = await getLocale();
  const identity = await getAppIdentity();

  if (!identity) redirect({ href: ROUTES.explore, locale });
  // A login with no app user yet (a pending claim, an unconfirmed email —
  // SEC-2a) is told why, rather than bounced back to the sign-in form.
  if (identity!.kind !== "user") redirect({ href: ROUTES.accountPending, locale });
  const user = identity!.kind === "user" ? identity!.user : null;

  const relations = await getUserCenterRelations(user!.id);

  // No branch: the admin console, the parent portal (verified children), the
  // person's own onboarding (F4 sign-up intent), or the hub.
  if (relations.length === 0) redirect({ href: await landingWithoutBranch(user!), locale });

  const activeCenterId = await getActiveCenterId();
  const relation =
    relations.find((item) => item.center.id === activeCenterId) ??
    (relations.length === 1 ? relations[0] : null);

  if (!relation) redirect({ href: ROUTES.selectCenter, locale });

  redirect({ href: homePathForRole(primaryRole(relation!)), locale });
}
