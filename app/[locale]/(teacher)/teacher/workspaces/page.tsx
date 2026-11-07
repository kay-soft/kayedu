import type { Metadata } from "next";
import { BriefcaseBusiness, Lock, Sparkles } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { NewWorkspaceButton } from "@/components/teacher/workspaces/workspace-controls";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { PremiumStatusBadge } from "@/components/shared/premium-status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isPremium, premiumStatus } from "@/lib/auth/premium";
import { requireTeacherUser } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { WORKSPACE_ACTIVE_CAP, listOwnedWorkspaces } from "@/lib/db/workspaces";
import { formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Workspaces.list");
  return { title: t("title") };
}

/**
 * Teacher → Workspaces (W8a, D-W38 item 10; docs/04 §11.37). Every signed-in
 * account reaches it through the teacher shell; the rows are the account's
 * own PERSONAL workspaces (`listOwnedWorkspaces`, through its personal
 * organization only), so nothing here is a tenant read across centres. A
 * non-premium account sees the premium card and its existing workspaces
 * read-only; "New workspace" is offered with premium, under the cap — and the
 * server re-checks both.
 */
export default async function TeacherWorkspacesPage() {
  const session = await requireTeacherUser();
  const [t, locale] = await Promise.all([getTranslations("Workspaces.list"), getLocale()]);
  const now = new Date();
  const premium = isPremium(session.user, now);
  const status = premiumStatus(session.user.premiumUntil, now);
  const rows = await listOwnedWorkspaces(prisma, session.user.id);
  const active = rows.filter((row) => row.archivedAt === null).length;
  const full = active >= WORKSPACE_ACTIVE_CAP;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />

      {premium ? (
        <Card>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-text-primary">
                {t("count", { active: formatNumber(active, locale), max: formatNumber(WORKSPACE_ACTIVE_CAP, locale) })}
              </p>
              <p className="text-xs text-text-secondary">{t("countHint")}</p>
            </div>
            <NewWorkspaceButton disabled={full} disabledReason={t("capReached", { max: WORKSPACE_ACTIVE_CAP })} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle as="h2" className="flex flex-wrap items-center gap-2">
              <Sparkles className="size-5 shrink-0 text-brand" aria-hidden />
              <span>{t("premiumTitle")}</span>
              <PremiumStatusBadge status={status} />
            </CardTitle>
            <CardDescription>{t("premiumDescription", { max: WORKSPACE_ACTIVE_CAP })}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {rows.length > 0 ? (
              <p className="flex items-start gap-2 text-sm text-warning-fg">
                <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{t("readOnly")}</span>
              </p>
            ) : null}
            <p className="text-sm font-medium text-text-primary">{t("premiumContact")}</p>
          </CardContent>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={<BriefcaseBusiness />} title={t("empty")} description={premium ? t("emptyHint") : undefined} />
          </CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={ROUTES.teacherWorkspace(row.id)}
                className="flex h-full min-h-24 flex-col gap-3 rounded-xl border border-border bg-surface p-4 transition-ui hover:border-border-strong hover:shadow-card-hover focus-ring"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0 break-words text-base font-semibold text-text-primary">{row.name}</span>
                  <Badge variant={row.archivedAt ? "neutral" : "success"}>
                    {row.archivedAt ? t("statusArchived") : t("statusActive")}
                  </Badge>
                </div>
                <span className="text-sm text-text-secondary">
                  {t("activeClasses", { count: row.activeClasses })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
