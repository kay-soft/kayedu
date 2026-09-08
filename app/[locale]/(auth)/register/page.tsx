import { getTranslations } from "next-intl/server";

import { RegisterForm } from "@/app/[locale]/(auth)/register/register-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { safeNextPath } from "@/lib/routes";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; email?: string }>;
}) {
  const { next, email } = await searchParams;
  const t = await getTranslations("Auth.register");

  return (
    <Card className="p-2 shadow-card sm:p-4">
      <CardHeader>
        <CardTitle className="text-xl font-bold text-text-primary">{t("title")}</CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <RegisterForm
          next={safeNextPath(next) ?? undefined}
          defaultEmail={email}
        />
      </CardContent>
    </Card>
  );
}
