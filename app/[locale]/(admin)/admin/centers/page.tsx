import { getLocale, getTranslations } from "next-intl/server";

import { CreateCenterForm } from "@/app/[locale]/(admin)/admin/centers/create-center-form";
import { LIFECYCLE_BADGE_VARIANT } from "@/app/[locale]/(admin)/admin/centers/lifecycle-badge";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { platformCenterList } from "@/lib/db/platform";
import { formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { Building2 } from "lucide-react";
import { ROUTES } from "@/lib/routes";

/**
 * Center tenant management (spec §4.4, M9): create a new Center + its
 * CenterSettings row in one flow, and list every tenant with basic stats and
 * its lifecycle state (M19). Lifecycle transitions happen on the detail page
 * — a card grid has no room for up to three valid next-state buttons per
 * tile, so this list stays read-only on that front. Platform-scoped by
 * design — no `centerId` filter here is deliberate, not a bug (docs/01 §4
 * "Multi-tenant isolation strategy" is about a tenant reaching another
 * tenant; the platform admin experience spans every tenant on purpose, spec
 * §3).
 */
export default async function AdminCentersPage() {
  await requirePlatformAdmin();

  const locale = await getLocale();
  const t = await getTranslations("AdminCenters");

  const centers = await platformCenterList(prisma);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <CreateCenterForm />

      <SectionHeader title={t("listTitle")} />
      {centers.length === 0 ? (
        <EmptyState icon={<Building2 />} tone="info" title={t("empty")} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {centers.map((center) => (
            <Card key={center.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <BrandAvatar
                    name={center.name}
                    themeColor={center.themeColor}
                    size="sm"
                  />
                  <Link
                    href={ROUTES.adminCenter(center.id)}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {center.name}
                  </Link>
                  <Badge variant={LIFECYCLE_BADGE_VARIANT[center.lifecycleState]}>
                    {t(`lifecycle.${center.lifecycleState}`)}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3 text-sm text-text-secondary">
                  <span dir="ltr" className="text-text-muted">
                    /{center.slug}
                  </span>
                </div>
                <div className="flex flex-wrap gap-4 text-sm text-text-secondary">
                  <span>{t("staffCount", { count: formatNumber(center.staffCount, locale) })}</span>
                  <span>{t("teacherCount", { count: formatNumber(center.teacherCount, locale) })}</span>
                  <span>{t("studentCount", { count: formatNumber(center.studentCount, locale) })}</span>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <LinkButton
                    href={ROUTES.adminCenter(center.id)}
                    variant="outline"
                    size="sm"
                  >
                    {t("openDetail")}
                  </LinkButton>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
