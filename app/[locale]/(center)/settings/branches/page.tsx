import { getLocale, getTranslations } from "next-intl/server";
import { Building2 } from "lucide-react";

import { LIFECYCLE_BADGE_VARIANT } from "@/app/[locale]/(admin)/admin/centers/lifecycle-badge";
import { AddBranchDialog } from "@/app/[locale]/(center)/settings/branches/add-branch-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionHeader } from "@/components/shared/section-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { getTenantContext, getUserCenterRelations, requirePermission } from "@/lib/auth/tenant";
import { CENTER_TIMEZONES } from "@/lib/branch-setup";
import { organizationBranchUsage } from "@/lib/db/branches";
import { prisma } from "@/lib/db/client";
import { formatNumber } from "@/lib/format";

/**
 * Settings → Branches (F1, OD-12 (b)) — OWNER only: `organization.branch.create`
 * is an ownership action no matrix row can grant (docs/02 §6). The
 * organization's usage against the limit a platform admin sets, every branch
 * with its lifecycle badge, and Add branch — disabled, with the reason, once
 * the limit is reached. The action re-checks all of it server-side.
 */
export default async function BranchesSettingsPage() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "organization.branch.create");

  const locale = await getLocale();
  const t = await getTranslations("Settings.branches");
  const tLifecycle = await getTranslations("AdminCenters.lifecycle");

  const [usage, relations] = await Promise.all([
    organizationBranchUsage(prisma, ctx.center.organizationId),
    getUserCenterRelations(ctx.user.id),
  ]);

  // "Copy setup from": the branches of this organization the Owner resolves.
  const sources = relations
    .filter(
      (relation) =>
        relation.center.organizationId === ctx.center.organizationId && relation.roles.includes("OWNER"),
    )
    .map((relation) => ({ id: relation.center.id, name: relation.center.name }));

  const used = usage?.used ?? 0;
  const max = usage?.maxBranches ?? 1;
  const atLimit = used >= max;
  const timezone = (CENTER_TIMEZONES as readonly string[]).includes(ctx.settings?.timezone ?? "")
    ? (ctx.settings?.timezone as (typeof CENTER_TIMEZONES)[number])
    : CENTER_TIMEZONES[0];

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <Card>
        <CardHeader>
          <CardTitle>
            {t("usage", { used: formatNumber(used, locale), max: formatNumber(max, locale) })}
          </CardTitle>
          <CardDescription>{atLimit ? t("atLimit") : t("underLimit")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <AddBranchDialog
            disabled={atLimit}
            sources={sources}
            defaultSourceId={ctx.center.id}
            defaultTimezone={timezone}
          />
          {atLimit ? (
            <p id="add-branch-disabled-reason" className="text-sm text-text-secondary">
              {t("atLimitReason")}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {!usage || usage.branches.length === 0 ? (
            <EmptyState compact icon={<Building2 />} title={t("empty")} />
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              {usage.branches.map((branch) => (
                <li
                  key={branch.id}
                  className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between md:rounded-none md:border-0 md:border-b md:px-2 md:py-3 md:last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">{branch.name}</p>
                    {branch.nameEn && branch.nameEn !== branch.name ? (
                      <p className="truncate text-xs text-text-muted" dir="ltr">
                        {branch.nameEn}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {branch.id === ctx.center.id ? <Badge variant="neutral">{t("current")}</Badge> : null}
                    <Badge variant={LIFECYCLE_BADGE_VARIANT[branch.lifecycleState]}>
                      {tLifecycle(branch.lifecycleState)}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
