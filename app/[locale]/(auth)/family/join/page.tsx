import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { JoinFamilyForm } from "@/components/family/join-family-form";
import { AuthCard } from "@/components/shared/auth-card";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { isStudentAccount } from "@/lib/db/parents";
import { fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Family.join");
  return { title: t("title") };
}

/**
 * `/[locale]/family/join` (F3, docs/04 §11.22) — where a parent accepts a
 * code. The code is in the URL fragment, which never reaches this server
 * component: `JoinFamilyForm` reads it in the browser and posts it. A guest
 * gets the field plus Sign in / Create a parent account, both returning here
 * (`next=/family/join` — the code itself waits in the tab, never in a query).
 * A signed-in student account is told up front it cannot be a parent; the
 * action refuses it regardless (`acceptFamilyCode`).
 */
export default async function FamilyJoinPage() {
  const user = await getCurrentUser();
  const [t, tParent] = await Promise.all([getTranslations("Family.join"), getTranslations("Family.parent")]);
  const studentAccount = user ? await isStudentAccount(prisma, user.id) : false;
  const next = `?next=${encodeURIComponent(ROUTES.familyJoin)}`;

  return (
    <AuthCard title={t("title")} description={t("description")}>
      <div className="flex flex-col gap-4">
        {user ? (
          <p className="text-sm text-text-secondary">{t("signedInAs", { name: fullName(user) })}</p>
        ) : null}

        {studentAccount ? (
          <div className="flex flex-col gap-3">
            <FormMessage>{t("studentAccount")}</FormMessage>
            <SignOutButton variant="light" />
          </div>
        ) : (
          <JoinFamilyForm
            mode="join"
            signedIn={Boolean(user)}
            signInHref={`${ROUTES.login}${next}`}
            registerHref={`${ROUTES.register}${next}`}
          />
        )}

        <p className="text-xs text-text-muted">{tParent("howToGet")}</p>

        {user ? (
          <LinkButton href={ROUTES.account} variant="ghost" className="w-full text-text-secondary">
            {t("backToAccount")}
          </LinkButton>
        ) : null}
      </div>
    </AuthCard>
  );
}
