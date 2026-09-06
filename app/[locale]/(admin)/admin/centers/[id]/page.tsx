import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Building2, GraduationCap, ShieldCheck, Users } from "lucide-react";

import { ActiveToggleForm } from "@/app/[locale]/(admin)/admin/centers/active-toggle-form";
import { PlanForm } from "@/app/[locale]/(admin)/admin/centers/[id]/plan-form";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { platformCenterDetailStats, recordSupportAccess } from "@/lib/db/platform";
import { formatDate, formatNumber } from "@/lib/format";

/**
 * A center's support view (spec §4.4 "controlled privileged support access").
 * Read-only, and every visit writes an `AuditLog` row before anything is
 * shown — the audit trail the spec asks for, not a full masquerade/
 * impersonation system (docs/03-build-order.md M9). The admin never acts on
 * this center's data from here — activate/suspend and the plan editor are
 * tenant-management, not "browsing tenant data", so they stay separate from
 * the recent-activity read below.
 */
export default async function AdminCenterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await requirePlatformAdmin();
  const { id } = await params;

  const center = await prisma.center.findUnique({ where: { id } });
  if (!center) notFound();

  await recordSupportAccess(prisma, { centerId: center.id, actorUserId: admin.id });

  const locale = await getLocale();
  const t = await getTranslations("AdminCenters");

  const [stats, recentAudit] = await Promise.all([
    platformCenterDetailStats(prisma, center.id),
    prisma.auditLog.findMany({
      where: { centerId: center.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { actor: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={center.name}
        description={t("detail.subtitle", { slug: center.slug })}
        action={
          <div className="flex items-center gap-2">
            <Badge variant={center.active ? "success" : "danger"}>
              {center.active ? t("active") : t("suspended")}
            </Badge>
            <ActiveToggleForm centerId={center.id} active={center.active} />
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("detail.stats.staff")}
          value={formatNumber(stats.staff, locale)}
          icon={<ShieldCheck className="size-4" />}
        />
        <StatCard
          label={t("detail.stats.teachers")}
          value={formatNumber(stats.teachers, locale)}
          icon={<GraduationCap className="size-4" />}
        />
        <StatCard
          label={t("detail.stats.students")}
          value={formatNumber(stats.students, locale)}
          icon={<Users className="size-4" />}
        />
        <StatCard
          label={t("detail.stats.sessions")}
          value={formatNumber(stats.sessions, locale)}
          icon={<Building2 className="size-4" />}
        />
      </div>

      <SectionHeader title={t("detail.planTitle")} description={t("detail.planDescription")} />
      <Card>
        <CardContent className="pt-6">
          <PlanForm centerId={center.id} plan={center.plan} />
        </CardContent>
      </Card>

      <SectionHeader
        title={t("detail.auditTitle")}
        description={t("detail.auditDescription")}
      />
      <Card>
        <CardContent className="pt-6">
          {recentAudit.length === 0 ? (
            <p className="text-sm text-text-muted">{t("detail.auditEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              {recentAudit.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-col gap-1 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3 md:last:border-0"
                >
                  <span className="w-44 shrink-0 text-xs text-text-muted" dir="ltr">
                    {formatDate(entry.createdAt, locale)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" dir="ltr">
                    {entry.action}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">
                    {entry.actor ? `${entry.actor.firstName} ${entry.actor.lastName}`.trim() : t("detail.unknownActor")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
