import { Clock } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { signOutAction } from "@/app/[locale]/(auth)/actions";
import { AuthCard } from "@/components/shared/auth-card";
import { SubmitButton } from "@/components/shared/submit-button";
import { getAppIdentity } from "@/lib/auth/session";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * A login that has no app user yet (SEC-2a, D-01):
 * - its email belongs to a person a centre created — the claim waits for that
 *   centre to confirm, in person, that this is them;
 * - its email is not confirmed yet (REQUIRE_EMAIL_CONFIRMATION);
 * - its email is held by another account.
 * Nothing here reveals whose record the email matched.
 */
export default async function AccountPendingPage() {
  const locale = await getLocale();
  const identity = await getAppIdentity();
  if (!identity) redirect({ href: ROUTES.login, locale });
  if (identity!.kind === "user") redirect({ href: "/", locale });

  const t = await getTranslations("Auth.accountPending");
  const reason = identity!.kind === "user" ? "blocked" : identity!.kind;

  return (
    <AuthCard title={t(`${reason}.title`)} description={t(`${reason}.body`)}>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-bg/60 p-4 text-sm text-text-secondary">
          <Clock className="mt-0.5 size-5 shrink-0 text-warning-fg" aria-hidden />
          <p>{t(`${reason}.next`)}</p>
        </div>
        <form action={signOutAction}>
          <input type="hidden" name="locale" value={locale} />
          <SubmitButton variant="outline" className="h-11 w-full">
            {t("signOut")}
          </SubmitButton>
        </form>
      </div>
    </AuthCard>
  );
}
