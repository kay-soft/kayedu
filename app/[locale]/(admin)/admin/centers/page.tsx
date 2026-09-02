import { getLocale, getTranslations } from "next-intl/server";

import { ActiveToggleForm } from "@/app/[locale]/(admin)/admin/centers/active-toggle-form";
import { CreateCenterForm } from "@/app/[locale]/(admin)/admin/centers/create-center-form";
import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { platformCenterList } from "@/lib/db/platform";
import { formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * Center tenant management (spec §4.4, M9): create a new Center + its
 * CenterSettings row in one flow, list every tenant with basic stats, and
 * activate/suspend a center. Platform-scoped by design — no `centerId`
 * filter here is deliberate, not a bug (docs/01 §4 "Multi-tenant isolation
 * strategy" is about a tenant reaching another tenant; the platform admin
 * experience spans every tenant on purpose, spec §3).
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
        <FormMessage tone="info">{t("empty")}</FormMessage>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {centers.map((center) => (
            <Card key={center.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
                    style={{ backgroundColor: center.themeColor }}
                  >
                    {center.name.trim().charAt(0)}
                  </span>
                  <Link
                    href={ROUTES.adminCenter(center.id)}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {center.name}
                  </Link>
                  <Badge variant={center.active ? "success" : "danger"}>
                    {center.active ? t("active") : t("suspended")}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3 text-sm text-text-secondary">
                  <span dir="ltr" className="text-text-muted">
                    /{center.slug}
                  </span>
                  {center.plan ? <Badge variant="brand">{center.plan}</Badge> : null}
                </div>
                <div className="flex flex-wrap gap-4 text-sm text-text-secondary">
                  <span>{t("staffCount", { count: formatNumber(center.staffCount, locale) })}</span>
                  <span>{t("teacherCount", { count: formatNumber(center.teacherCount, locale) })}</span>
                  <span>{t("studentCount", { count: formatNumber(center.studentCount, locale) })}</span>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Link
                    href={ROUTES.adminCenter(center.id)}
                    className="text-sm font-medium text-brand hover:underline"
                  >
                    {t("openDetail")}
                  </Link>
                  <ActiveToggleForm centerId={center.id} active={center.active} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
