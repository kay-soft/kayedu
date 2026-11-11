import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarClock, CalendarDays, Coins } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { BrandAvatar } from "@/components/shared/brand-avatar";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAssistantScope, scopeBranches } from "@/lib/auth/assistant-context";
import { prisma } from "@/lib/db/client";
import { combineTeacherSummaries, teacherCenterSummary, teacherDashboardAnchors } from "@/lib/db/teacher-portal";
import { formatMoney, formatNumber } from "@/lib/format";
import { centerLogoSrc } from "@/lib/storage-paths";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.work.overview");
  return { title: t("title") };
}

/**
 * The teacher's earnings overview, for their assistant (W7b, D-W37 item 6) —
 * `analytics.view` only (the Full preset), read-only: the teacher dashboard's
 * own summary function (`teacherCenterSummary`) per branch where `assistantCan`
 * grants it (the teacher's `analytics.own.view` cell, the branch setting),
 * summed in memory (U7), each floored at the assistant's window (D-W19). No
 * settlements, no centre money, no account or premium page — ever.
 */
export default async function AssistantOverviewPage({ params }: { params: Promise<{ teacherId: string }> }) {
  const { teacherId } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const branches = scopeBranches(scope, "analytics.view");
  if (branches.length === 0) notFound();

  const t = await getTranslations("Assistants.work.overview");
  const locale = await getLocale();
  const now = new Date();
  const summaries = await Promise.all(
    branches.map((branch) => {
      const { today, week, month } = teacherDashboardAnchors(branch.zone, now);
      return teacherCenterSummary(prisma, branch.centerId, teacherId, today, week, { from: month.start, to: month.end }, branch.floor);
    }),
  );
  const combined = combineTeacherSummaries(summaries);
  const byCenter = new Map(summaries.map((summary) => [summary.centerId, summary]));
  const earnings = summaries.reduce((sum, summary) => sum + summary.earnings.teacherShare, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { teacher: scope.link.teacherName })} />
      <StatGrid count={3}>
        <StatCard label={t("sessionsToday")} value={formatNumber(combined.sessionsToday, locale)} icon={<CalendarClock className="size-4" />} />
        <StatCard label={t("sessionsThisWeek")} value={formatNumber(combined.sessionsThisWeek, locale)} icon={<CalendarDays className="size-4" />} />
        <StatCard label={t("earningsThisMonth")} value={formatMoney(earnings, locale)} icon={<Coins className="size-4" />} />
      </StatGrid>
      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("branchesTitle")}</CardTitle>
          <CardDescription>{t("branchesHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {branches.map((branch) => {
            const summary = byCenter.get(branch.centerId);
            return (
              <div key={branch.centerId} className="flex min-w-0 items-center gap-3 rounded-xl border border-border p-4">
                <BrandAvatar
                  name={branch.centerName}
                  logoUrl={centerLogoSrc(branch.ctx.center)}
                  themeColor={branch.ctx.center.themeColor}
                  size="lg"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{branch.centerName}</p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {t("branchLine", {
                      today: formatNumber(summary?.sessionsToday ?? 0, locale),
                      week: formatNumber(summary?.sessionsThisWeek ?? 0, locale),
                      earnings: formatMoney(summary?.earnings.teacherShare ?? 0, locale),
                    })}
                  </p>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
