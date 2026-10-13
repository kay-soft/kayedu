import { getTranslations } from "next-intl/server";

import { RegisterForm } from "@/app/[locale]/(auth)/register/register-form";
import { AuthCard } from "@/components/shared/auth-card";
import { safeNextPath } from "@/lib/routes";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; email?: string }>;
}) {
  const { next, email } = await searchParams;
  const t = await getTranslations("Auth.register");

  return (
    <AuthCard title={t("title")} description={t("subtitle")}>
      <RegisterForm
        next={safeNextPath(next) ?? undefined}
        defaultEmail={email}
      />
    </AuthCard>
  );
}
