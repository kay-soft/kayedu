import { Building2, CalendarClock, CalendarDays, Coins, Star } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { selectCenterAction } from "@/app/[locale]/(auth)/actions";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTeacherContexts, getTenantContext } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { teacherRatingAverage } from "@/lib/db/ratings";
import {
  combineTeacherSummaries,
  teacherCenterSummary,
  teacherDashboardAnchors,
} from "@/lib/db/teacher-portal";
import { formatMoney, formatNumber, formatRating } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone } from "@/lib/scheduling";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { LinkButton } from "@/components/shared/link-button";

/**
 * The teacher dashboard (spec §4.2 item 0/1, docs/03 M7): a combined summary
 * across every center this teacher belongs to, plus one card per center with
 * that center's own schedule/earnings — each computed by its own centerId-
 * scoped query (`teacherCenterSummary`) and only *unioned* here in memory
 * (docs/01 §4 "Teacher cross-center visibility"). Switching which center is
 * active reuses the existing `/select-center` cookie flow — the same one the
 * shell's "Switch center" link already drives.
 */
export default async function TeacherDashboardPage() {
  const ctx = await getTenantContext("teacher");
  const contexts = await getTeacherContexts(ctx.user.id);
  const t = await getTranslations("TeacherDashboard");
  const tRoles = await getTranslations("Roles");
  const locale = await getLocale();

  // R7b: a teacher works at centres that may sit in different timezones, so
  // "today", "this week" and "this month" are resolved **per centre** — each
  // centre's own calendar day anchors its own scoped query, and only the
  // resulting counts/totals are summed in memory (`combineTeacherSummaries`).
  // There is no single global day.
  const now = new Date();

  const summaries = await Promise.all(
    contexts.map((centerCtx) => {
      const { today, week, month } = teacherDashboardAnchors(centreTimeZone(centerCtx.settings), now);
      return teacherCenterSummary(
        prisma,
        centerCtx.center.id,
        ctx.user.id,
        today,
        week,
        { from: month.start, to: month.end },
      );
    }),
  );
  const combined = combineTeacherSummaries(summaries);
  const summaryByCenter = new Map(summaries.map((summary) => [summary.centerId, summary]));

  // M17, spec §5 "Teacher ratings": the same average-out-of-5-only shape
  // every other reader of this aggregate gets — a teacher reading their own
  // rating is never shown a count either, and there is no separate,
  // privileged rating query for this page to call.
  const rating = await teacherRatingAverage(prisma, ctx.user.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle", { center: ctx.center.name })}
        action={<Badge variant="brand">{tRoles(ctx.role)}</Badge>}
      />

      <StatGrid count={5}>
        <StatCard
          label={t("stats.centers")}
          value={formatNumber(combined.centerCount, locale)}
          icon={<Building2 className="size-4" />}
        />
        <StatCard
          label={t("stats.sessionsToday")}
          value={formatNumber(combined.sessionsToday, locale)}
          icon={<CalendarClock className="size-4" />}
        />
        <StatCard
          label={t("stats.sessionsThisWeek")}
          value={formatNumber(combined.sessionsThisWeek, locale)}
          icon={<CalendarDays className="size-4" />}
        />
        <StatCard
          label={t("stats.earningsThisMonth")}
          value={formatMoney(combined.teacherShare, locale)}
          icon={<Coins className="size-4" />}
        />
        <StatCard
          label={t("stats.rating")}
          value={rating.average !== null ? formatRating(rating.average, locale) : t("stats.ratingNone")}
          icon={<Star className="size-4" />}
        />
      </StatGrid>

      <Card>
        <CardHeader>
          <CardTitle>{t("centers.title")}</CardTitle>
          <CardDescription>{t("centers.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {contexts.map((centerCtx) => {
            const summary = summaryByCenter.get(centerCtx.center.id);
            const isActive = centerCtx.center.id === ctx.center.id;

            return (
              <div
                key={centerCtx.center.id}
                className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <BrandAvatar
                    name={centerCtx.center.name}
                    logoUrl={centerCtx.center.logoUrl}
                    themeColor={centerCtx.center.themeColor}
                    size="lg"
                  />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 truncate text-sm font-semibold text-text-primary">
                      {centerCtx.center.name}
                      {isActive ? (
                        <Badge variant="brand">{t("centers.active")}</Badge>
                      ) : null}
                    </p>
                    <p className="mt-1 text-xs text-text-muted">
                      {t("centers.summary", {
                        today: summary?.sessionsToday ?? 0,
                        week: summary?.sessionsThisWeek ?? 0,
                        earnings: formatMoney(summary?.earnings.teacherShare ?? 0, locale),
                      })}
                    </p>
                  </div>
                </div>

                {isActive ? (
                  <LinkButton href={ROUTES.teacherSessions} className="shrink-0">
                    {t("centers.viewSchedule")}
                  </LinkButton>
                ) : (
                  <form action={selectCenterAction} className="shrink-0">
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="centerId" value={centerCtx.center.id} />
                    <Button type="submit" variant="outline" className="h-11 w-full px-4 sm:w-auto">
                      {t("centers.switchTo")}
                    </Button>
                  </form>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
