import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Building2 } from "lucide-react";

import { LIFECYCLE_BADGE_VARIANT } from "@/app/[locale]/(admin)/admin/centers/lifecycle-badge";
import { DeletedBranches } from "@/app/[locale]/(admin)/admin/centers/branch-tools";
import { BranchLimitForm } from "@/app/[locale]/(admin)/admin/organizations/branch-limit-form";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { platformDeletedBranches } from "@/lib/db/branch-admin";
import { prisma } from "@/lib/db/client";
import { platformCenterList, platformOrganizationById } from "@/lib/db/platform";
import { formatNumber } from "@/lib/format";
import { ROUTES } from "@/lib/routes";

/**
 * One organization (F1): its branches with their lifecycle badge and counts,
 * linking to each branch's own `/admin/centers/[id]` support view, and the
 * branch-limit editor. Counts only — no tenant data is browsed here, so this
 * page writes no support-access row (opening a branch's detail still does).
 */
export default async function AdminOrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePlatformAdmin();
  const { id } = await params;

  const organization = await platformOrganizationById(prisma, id);
  if (!organization) notFound();

  const locale = await getLocale();
  const t = await getTranslations("AdminOrganizations");
  const tCenters = await getTranslations("AdminCenters");

  const tBranches = await getTranslations("AdminBranches");
  const now = new Date();
  // U5: deleted branches are not listed with the others (and do not count);
  // they have their own section below, with Restore while their window lasts.
  const [branches, deletedBranches] = await Promise.all([
    platformCenterList(prisma, organization.id),
    platformDeletedBranches(prisma, organization.id),
  ]);
  const used = branches.filter((branch) => branch.lifecycleState !== "ARCHIVED").length;
  const name = locale === "en" && organization.nameEn ? organization.nameEn : organization.name;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={name}
        description={t("detail.subtitle")}
        back={{ href: ROUTES.adminOrganizations, label: t("backToList") }}
        meta={
          <Badge variant={used >= organization.maxBranches ? "warning" : "neutral"}>
            {t("usage", {
              used: formatNumber(used, locale),
              max: formatNumber(organization.maxBranches, locale),
            })}
          </Badge>
        }
      />

      <SectionHeader title={t("limit.title")} description={t("limit.description")} />
      <Card>
        <CardContent>
          <BranchLimitForm organizationId={organization.id} maxBranches={organization.maxBranches} used={used} />
        </CardContent>
      </Card>

      <SectionHeader title={t("detail.branchesTitle")} description={t("detail.branchesDescription")} />
      {branches.length === 0 ? (
        <EmptyState icon={<Building2 />} tone="info" title={t("detail.noBranches")} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {branches.map((branch) => (
            <li key={branch.id}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <BrandAvatar name={branch.name} themeColor={branch.themeColor} size="sm" />
                    <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{branch.name}</span>
                    <Badge variant={LIFECYCLE_BADGE_VARIANT[branch.lifecycleState]}>
                      {tCenters(`lifecycle.${branch.lifecycleState}`)}
                    </Badge>
                  </div>
                  <span dir="ltr" className="text-sm text-text-muted">
                    /{branch.slug}
                  </span>
                  <div className="flex flex-wrap gap-4 text-sm text-text-secondary">
                    <span>{tCenters("staffCount", { count: formatNumber(branch.staffCount, locale) })}</span>
                    <span>{tCenters("teacherCount", { count: formatNumber(branch.teacherCount, locale) })}</span>
                    <span>{tCenters("studentCount", { count: formatNumber(branch.studentCount, locale) })}</span>
                  </div>
                  <div className="mt-auto pt-1">
                    <LinkButton href={ROUTES.adminCenter(branch.id)} variant="outline" size="sm">
                      {tBranches("manage")}
                    </LinkButton>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <DeletedBranches
        rows={deletedBranches.map((branch) => ({
          id: branch.id,
          name: branch.name,
          themeColor: branch.themeColor,
          deletedAt: branch.deletedAt!,
          restorableUntil: branch.restorableUntil,
          restorable: branch.restorableUntil !== null && branch.restorableUntil.getTime() >= now.getTime(),
        }))}
      />
    </div>
  );
}
