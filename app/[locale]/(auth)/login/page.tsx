import { getTranslations } from "next-intl/server";

import { LoginForm } from "@/app/[locale]/(auth)/login/login-form";
import { AuthCard } from "@/components/shared/auth-card";
import { safeNextPath } from "@/lib/routes";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const t = await getTranslations("Auth.login");

  return (
    <AuthCard title={t("title")} description={t("subtitle")}>
      <LoginForm next={safeNextPath(next) ?? undefined} />
    </AuthCard>
  );
}
