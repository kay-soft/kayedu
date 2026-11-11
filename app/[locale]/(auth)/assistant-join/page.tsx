import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { JoinAssistantForm } from "@/components/assistants/join-assistant-form";
import { AuthCard } from "@/components/shared/auth-card";
import { LinkButton } from "@/components/shared/link-button";
import { getCurrentUser } from "@/lib/auth/session";
import { fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.join");
  return { title: t("title") };
}

/**
 * `/[locale]/assistant-join` (W7a, D-W36, docs/04 §11.36) — where any account
 * redeems an assistant code: a receptionist, a parent, a student, anyone but
 * the teacher. A guest gets the field plus Sign in / Create an account, both
 * returning here (`next=/assistant-join`; the code itself waits in the tab,
 * never in a query) — that is "redeemable at sign-up". Nothing links before
 * the confirmation's Confirm (`JoinAssistantForm`).
 */
export default async function AssistantJoinPage() {
  const user = await getCurrentUser();
  const t = await getTranslations("Assistants.join");
  const next = `?next=${encodeURIComponent(ROUTES.assistantJoin)}`;

  return (
    <AuthCard title={t("title")} description={t("description")}>
      <div className="flex flex-col gap-4">
        {user ? <p className="text-sm text-text-secondary">{t("signedInAs", { name: fullName(user) })}</p> : null}
        <JoinAssistantForm
          mode="join"
          signedIn={Boolean(user)}
          signInHref={`${ROUTES.login}${next}`}
          registerHref={`${ROUTES.register}${next}`}
        />
        <p className="text-xs text-text-muted">{t("howToGet")}</p>
        {user ? (
          <LinkButton href={ROUTES.account} variant="ghost" className="w-full text-text-secondary">
            {t("backToAccount")}
          </LinkButton>
        ) : null}
      </div>
    </AuthCard>
  );
}
