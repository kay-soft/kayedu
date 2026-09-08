import { getTranslations } from "next-intl/server";

import { LoginForm } from "@/app/[locale]/(auth)/login/login-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { safeNextPath } from "@/lib/routes";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const t = await getTranslations("Auth.login");

  return (
    <Card className="p-2 shadow-card sm:p-4">
      <CardHeader>
        <CardTitle className="text-xl font-bold text-text-primary">{t("title")}</CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm next={safeNextPath(next) ?? undefined} />
      </CardContent>
    </Card>
  );
}
