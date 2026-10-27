import { getLocale, getTranslations } from "next-intl/server";

import { LinkButton } from "@/components/shared/link-button";
import { PublicHeader } from "@/components/shared/public-header";

import { getAppIdentity } from "@/lib/auth/session";
import { getActiveCenterId } from "@/lib/auth/active-center";
import { getUserCenterRelations, landingWithoutBranch, primaryRole } from "@/lib/auth/tenant";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, homePathForRole } from "@/lib/routes";

/**
 * Entry point: send everyone to the surface they belong in
 * (docs/02 §3 — resolve identity → memberships → center → role).
 *
 * Signed out, `/` is the public landing (DES, docs/04 §12): the product name,
 * one plain line, Sign in and Create an account. No pricing, no claims. Every
 * signed-in path below is unchanged.
 */
export default async function HomePage() {
  const locale = await getLocale();
  const identity = await getAppIdentity();

  if (!identity) return <PublicLanding />;
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

async function PublicLanding() {
  const t = await getTranslations("Public.landing");
  const tShell = await getTranslations("Shell");

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-text-primary">
      <PublicHeader />
      <main className="flex flex-1 items-center justify-center px-4 pb-16 sm:px-6">
        <div className="flex w-full max-w-lg flex-col items-center gap-6 text-center">
          <div className="flex flex-col gap-3">
            <h1 className="text-4xl font-bold tracking-tight text-balance text-text-primary sm:text-5xl">
              {tShell("productName")}
            </h1>
            <p className="text-lg text-pretty text-text-secondary">{t("tagline")}</p>
          </div>
          <div className="grid w-full gap-2 sm:flex sm:w-auto sm:justify-center">
            <LinkButton href={ROUTES.login} variant="default" className="h-12 px-6 text-base">
              {t("signIn")}
            </LinkButton>
            <LinkButton href={ROUTES.register} className="h-12 px-6 text-base">
              {t("register")}
            </LinkButton>
          </div>
          <p className="max-w-sm text-sm text-pretty text-text-muted">{t("note")}</p>
        </div>
      </main>
    </div>
  );
}
