import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { JoinWorkspaceForm } from "@/components/workspaces/join-workspace-form";
import { AuthCard } from "@/components/shared/auth-card";
import { LinkButton } from "@/components/shared/link-button";
import { getCurrentUser } from "@/lib/auth/session";
import { fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("WorkspaceJoin");
  return { title: t("title") };
}

/**
 * `/[locale]/workspace-join` (W10, D-W43; docs/04 §11.37) — where any
 * signed-in account redeems a private-class share code from a teacher. A
 * guest gets the field plus Sign in / Create an account, both returning here
 * (`next=/workspace-join`; the code itself waits in the tab, never in a
 * query). Nothing links before the confirmation's Confirm
 * (`JoinWorkspaceForm`).
 */
export default async function WorkspaceJoinPage() {
  const user = await getCurrentUser();
  const t = await getTranslations("WorkspaceJoin");
  const next = `?next=${encodeURIComponent(ROUTES.workspaceJoin)}`;

  return (
    <AuthCard title={t("title")} description={t("description")}>
      <div className="flex flex-col gap-4">
        {user ? <p className="text-sm text-text-secondary">{t("signedInAs", { name: fullName(user) })}</p> : null}
        <JoinWorkspaceForm
          signedIn={Boolean(user)}
          signInHref={`${ROUTES.login}${next}`}
          registerHref={`${ROUTES.register}${next}`}
        />
        <p className="text-xs text-text-muted">{t("howToGet")}</p>
        {user ? (
          <LinkButton href={ROUTES.selectCenter} variant="ghost" className="w-full text-text-secondary">
            {t("backToHub")}
          </LinkButton>
        ) : null}
      </div>
    </AuthCard>
  );
}
