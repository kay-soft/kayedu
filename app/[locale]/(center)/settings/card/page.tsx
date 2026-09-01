import { getTranslations } from "next-intl/server";

import { CardLayoutForm } from "@/app/[locale]/(center)/settings/card/card-form";
import { FormMessage } from "@/components/shared/form-message";
import { SectionHeader } from "@/components/shared/section-header";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";

export default async function CardCustomizationPage() {
  const ctx = await getTenantContext({ experience: "center" });
  await requirePermission(ctx, "center.settings.edit");

  const settings = await scoped(ctx).settings.get();
  const t = await getTranslations("Settings.card");

  const layout = settings?.cardLayout;
  const initialJson =
    layout === null || layout === undefined
      ? ""
      : JSON.stringify(layout, null, 2);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <FormMessage tone="info">{t("rendererNote")}</FormMessage>

      <CardLayoutForm initialJson={initialJson} />
    </div>
  );
}
