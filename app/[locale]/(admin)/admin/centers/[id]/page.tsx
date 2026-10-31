import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Building2, GraduationCap, ScrollText, ShieldCheck, Users } from "lucide-react";

import {
  BranchDeleteDialog,
  BranchEditForm,
  BranchPauseCard,
} from "@/app/[locale]/(admin)/admin/centers/branch-tools";
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
import { branchDeleteBlocker } from "@/lib/db/branch-admin";
import { branchTodayKey, liveBranchPause } from "@/lib/db/branch-pauses";
import { prisma } from "@/lib/db/client";
import { DEFAULT_VISIBILITY_WINDOW_DAYS } from "@/lib/db/visibility";
import {
  platformCenterDetailStats,
  recordSupportAccess,
  validNextLifecycleStates,
  platformCenterById,
  platformCenterAuditTrail,
  centerSettingsFor,
} from "@/lib/db/platform";
import { formatDate, formatNumber } from "@/lib/format";
import { EmptyState } from "@/components/shared/empty-state";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { ROUTES } from "@/lib/routes";

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

  const center = await platformCenterById(prisma, id);
  if (!center) notFound();

  await recordSupportAccess(prisma, { centerId: center.id, actorUserId: admin.id });

  const locale = await getLocale();
  const t = await getTranslations("AdminCenters");

  const now = new Date();
  const deleted = center.deletedAt !== null;
  const [stats, recentAudit, settings, todayKey, livePause, deleteBlocker] = await Promise.all([
    platformCenterDetailStats(prisma, center.id),
    platformCenterAuditTrail(prisma, center.id),
    centerSettingsFor(prisma, center.id),
    branchTodayKey(prisma, center.id, now),
    deleted ? null : liveBranchPause(prisma, center.id, now),
    deleted ? null : branchDeleteBlocker(prisma, center, now),
  ]);
  const tBranches = await getTranslations("AdminBranches");

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
        back={{ href: ROUTES.adminOrganization(center.organizationId), label: tBranches("backToOrganization") }}
      />

      {deleted ? (
        // U5: a deleted branch is read-only here; it is restored from its organization's page.
        <div className="flex flex-col gap-3">
          <FormMessage tone="warning">
            {tBranches("deletedNotice", {
              date: formatDate(center.deletedAt!, locale),
              until: formatDate(center.restorableUntil ?? center.deletedAt!, locale),
            })}
          </FormMessage>
          <LinkButton href={ROUTES.adminOrganization(center.organizationId)} variant="outline">
            {tBranches("restore.goToOrganization")}
          </LinkButton>
        </div>
      ) : null}

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

      {deleted ? null : (
        <>
          <SectionHeader title={tBranches("edit.title")} description={tBranches("edit.description")} />
          <Card>
            <CardContent>
              <BranchEditForm
                centerId={center.id}
                name={center.name}
                nameEn={center.nameEn}
                themeColor={center.themeColor}
              />
            </CardContent>
          </Card>

          <SectionHeader title={tBranches("pause.title")} description={tBranches("pause.description")} />
          <Card>
            <CardContent>
              <BranchPauseCard
                centerId={center.id}
                todayKey={todayKey}
                pause={
                  livePause
                    ? {
                        id: livePause.id,
                        startDate: livePause.startDate,
                        endDate: livePause.endDate,
                        current: livePause.startDate.toISOString().slice(0, 10) <= todayKey,
                      }
                    : null
                }
              />
            </CardContent>
          </Card>

          <SectionHeader
            title={t("detail.lifecycleTitle")}
            description={t("detail.lifecycleDescription")}
          />
          <Card>
            <CardContent>
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
            <CardContent>
              <VisibilityWindowForm
                centerId={center.id}
                dataVisibilityDays={settings?.dataVisibilityDays ?? DEFAULT_VISIBILITY_WINDOW_DAYS}
              />
            </CardContent>
          </Card>

          <SectionHeader title={tBranches("delete.sectionTitle")} description={tBranches("delete.sectionDescription")} />
          <Card>
            <CardContent>
              <BranchDeleteDialog centerId={center.id} branchName={center.name} blocker={deleteBlocker} />
            </CardContent>
          </Card>
        </>
      )}

      <SectionHeader
        title={t("detail.auditTitle")}
        description={t("detail.auditDescription")}
      />
      <Card>
        <CardContent>
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
