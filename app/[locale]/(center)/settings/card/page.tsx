import { getTranslations } from "next-intl/server";

import { CardLayoutForm } from "@/app/[locale]/(center)/settings/card/card-form";
import { SectionHeader } from "@/components/shared/section-header";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { resolveCardLayout } from "@/lib/id-card";
import { scoped } from "@/lib/db/scoped";

export default async function CardCustomizationPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "center.settings.edit");

  const settings = await scoped(ctx).settings.get();
  const t = await getTranslations("Settings.card");

  // The centre never sees this layout as JSON (M18) — resolved straight into
  // the element map the visual editor drags/resizes/adds/removes directly.
  const layout = resolveCardLayout(settings?.cardLayout);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <CardLayoutForm
        initialElements={layout.elements}
        background={layout.background}
        accent={layout.accent}
        footer={layout.footer}
        headerBand={layout.headerBand}
        centerName={ctx.center.name}
        brandColor={ctx.center.themeColor}
      />
    </div>
  );
}
