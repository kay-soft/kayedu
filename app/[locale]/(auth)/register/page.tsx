import { getTranslations } from "next-intl/server";

import { RegisterForm } from "@/app/[locale]/(auth)/register/register-form";
import { AuthCard } from "@/components/shared/auth-card";
import { ROUTES, safeNextPath } from "@/lib/routes";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; email?: string }>;
}) {
  const { next, email } = await searchParams;
  const t = await getTranslations("Auth.register");
  const safeNext = safeNextPath(next) ?? undefined;
  // A parent who followed a join link has said which one they are already.
  const defaultIntent = safeNext?.includes(ROUTES.familyJoin) ? "PARENT" : null;

  return (
    <AuthCard title={t("title")} description={t("subtitle")}>
      <RegisterForm
        next={safeNext}
        defaultEmail={email}
        defaultIntent={defaultIntent}
      />
    </AuthCard>
  );
}
