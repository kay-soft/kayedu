import { getTranslations } from "next-intl/server";

import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { getTenantContext } from "@/lib/auth/tenant";

export default async function TeacherDashboardPage() {
  const ctx = await getTenantContext("teacher");
  const t = await getTranslations("TeacherDashboard");
  const tRoles = await getTranslations("Roles");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle", { center: ctx.center.name })}
        action={<Badge variant="brand">{tRoles(ctx.role)}</Badge>}
      />
      <FormMessage tone="info">{t("milestoneNote")}</FormMessage>
    </div>
  );
}
