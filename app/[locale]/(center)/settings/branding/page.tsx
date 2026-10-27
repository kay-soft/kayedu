import { getTranslations } from "next-intl/server";

import { LogoForm } from "@/app/[locale]/(center)/settings/branding/logo-form";
import { SectionHeader } from "@/components/shared/section-header";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { centerLogoSrc } from "@/lib/storage-paths";

export default async function BrandingPage() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "center.settings.edit");
  const t = await getTranslations("Settings.branding");

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />
      <LogoForm
        branchName={ctx.center.name}
        themeColor={ctx.center.themeColor}
        logoSrc={centerLogoSrc(ctx.center)}
      />
    </div>
  );
}
