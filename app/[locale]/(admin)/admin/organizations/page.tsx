import { getLocale, getTranslations } from "next-intl/server";
import { Network } from "lucide-react";

import { BrandAvatar } from "@/components/shared/brand-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { platformOrganizationList } from "@/lib/db/platform";
import { formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * Every organization (the paying customer — "Center" in the UI) with its
 * branch usage against the limit a platform admin sets (F1, OD-12). Reached
 * from a button on `/admin/centers`, not from the sidebar. Platform-scoped by
 * design: an organization isolates nothing (docs/01, Organization layer).
 */
export default async function AdminOrganizationsPage() {
  await requirePlatformAdmin();

  const locale = await getLocale();
  const t = await getTranslations("AdminOrganizations");
  const organizations = await platformOrganizationList(prisma);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        back={{ href: ROUTES.adminCenters, label: t("backToBranches") }}
      />

      {organizations.length === 0 ? (
        <EmptyState icon={<Network />} tone="info" title={t("empty")} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {organizations.map((organization) => {
            const atLimit = organization.usedBranches >= organization.maxBranches;
            const name = locale === "en" && organization.nameEn ? organization.nameEn : organization.name;
            return (
              <Card key={organization.id}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BrandAvatar name={name} size="sm" />
                    <Link
                      href={ROUTES.adminOrganization(organization.id)}
                      className="min-w-0 flex-1 truncate hover:underline"
                    >
                      {name}
                    </Link>
                    {/* Usage is a fact, not a status — neutral unless full. */}
                    <Badge variant={atLimit ? "warning" : "neutral"}>
                      {t("usage", {
                        used: formatNumber(organization.usedBranches, locale),
                        max: formatNumber(organization.maxBranches, locale),
                      })}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-sm text-text-secondary">
                    {organization.totalBranches > organization.usedBranches
                      ? t("archivedNote", {
                          count: formatNumber(organization.totalBranches - organization.usedBranches, locale),
                        })
                      : t("countedNote")}
                  </p>
                  <div>
                    <LinkButton href={ROUTES.adminOrganization(organization.id)} variant="outline" size="sm">
                      {t("openDetail")}
                    </LinkButton>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
