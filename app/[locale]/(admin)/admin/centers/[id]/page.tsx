import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Building2, GraduationCap, ScrollText, ShieldCheck, Users } from "lucide-react";

import { LifecycleTransitionForm } from "@/app/[locale]/(admin)/admin/centers/lifecycle-transition-form";
import { LIFECYCLE_BADGE_VARIANT } from "@/app/[locale]/(admin)/admin/centers/lifecycle-badge";
import { VisibilityWindowForm } from "@/app/[locale]/(admin)/admin/centers/visibility-window-form";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { DEFAULT_VISIBILITY_WINDOW_DAYS } from "@/lib/db/visibility";
import {
  platformCenterDetailStats,
  recordSupportAccess,
  validNextLifecycleStates,
} from "@/lib/db/platform";
import { formatDate, formatNumber } from "@/lib/format";
import { EmptyState } from "@/components/shared/empty-state";

/**
 * A center's support view (spec §4.4 "controlled privileged support access").
 * Read-only except for two tenant-management controls — the lifecycle
 * transition and the data-visibility-window override (M19) — which stay
 * separate from the recent-activity read below, since acting on the tenant
 * itself is not "browsing tenant data". Every visit writes an `AuditLog` row
 * before anything is shown — the audit trail the spec asks for, not a full
 * masquerade/impersonation system (docs/03-build-order.md M9).
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

  const [stats, recentAudit, settings] = await Promise.all([
    platformCenterDetailStats(prisma, center.id),
    prisma.auditLog.findMany({
      where: { centerId: center.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { actor: true },
    }),
    prisma.centerSettings.findUnique({ where: { centerId: center.id } }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={center.name}
        description={t("detail.subtitle", { slug: center.slug })}
        action={
          <Badge variant={LIFECYCLE_BADGE_VARIANT[center.lifecycleState]}>
            {t(`lifecycle.${center.lifecycleState}`)}
          </Badge>
        }
      />

      <StatGrid count={4}>
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
      </StatGrid>

      <SectionHeader
        title={t("detail.lifecycleTitle")}
        description={t("detail.lifecycleDescription")}
      />
      <Card>
        <CardContent className="pt-6">
          <LifecycleTransitionForm
            centerId={center.id}
            validNext={validNextLifecycleStates(center.lifecycleState)}
          />
        </CardContent>
      </Card>

      <SectionHeader
        title={t("detail.visibilityTitle")}
        description={t("detail.visibilityDescription")}
      />
      <Card>
        <CardContent className="pt-6">
          <VisibilityWindowForm
            centerId={center.id}
            dataVisibilityDays={settings?.dataVisibilityDays ?? DEFAULT_VISIBILITY_WINDOW_DAYS}
          />
        </CardContent>
      </Card>

      <SectionHeader
        title={t("detail.auditTitle")}
        description={t("detail.auditDescription")}
      />
      <Card>
        <CardContent className="pt-6">
          {recentAudit.length === 0 ? (
            <EmptyState compact icon={<ScrollText />} title={t("detail.auditEmpty")} description={t("detail.auditEmptyHint")} />
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
