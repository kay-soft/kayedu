import { getTranslations } from "next-intl/server";

import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { getTenantContext } from "@/lib/auth/tenant";

export default async function StudentSchedulePage() {
  const ctx = await getTenantContext({ experience: "student" });
  const t = await getTranslations("StudentSchedule");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle", { center: ctx.center.name })}
      />
      <FormMessage tone="info">{t("milestoneNote")}</FormMessage>
    </div>
  );
}
