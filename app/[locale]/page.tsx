import { getLocale } from "next-intl/server";

import { getAppIdentity } from "@/lib/auth/session";
import { singleExperienceHome } from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * Entry point: send everyone to the surface they belong in
 * (docs/02 §3 — resolve identity → memberships → center → role).
 *
 * Signed out, `/` lands on Explore (F5) — the public pages where anyone can
 * browse branches, classes and teachers; it replaced the DES landing.
 *
 * U7: signed in, the same rule as sign-in — one experience goes straight to
 * it (a single staff branch auto-resolves, `getTenantContext`), several show
 * the hub (`singleExperienceHome`).
 */
export default async function HomePage() {
  const locale = await getLocale();
  const identity = await getAppIdentity();

  if (!identity) redirect({ href: ROUTES.explore, locale });
  // A login with no app user yet (a pending claim, an unconfirmed email —
  // SEC-2a) is told why, rather than bounced back to the sign-in form.
  if (identity!.kind !== "user") redirect({ href: ROUTES.accountPending, locale });
  const user = identity!.kind === "user" ? identity!.user : null;

  const home = await singleExperienceHome(user!);
  redirect({ href: home?.href ?? ROUTES.selectCenter, locale });
}
