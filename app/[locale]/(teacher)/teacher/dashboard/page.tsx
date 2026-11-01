import { Building2, CalendarClock, CalendarDays, Coins, Star } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan } from "@/lib/auth/tenant";
import { getTeacherScope } from "@/lib/auth/teacher-scope";
import { prisma } from "@/lib/db/client";
import { teacherRatingAverage } from "@/lib/db/ratings";
import {
  combineTeacherSummaries,
  teacherCenterSummary,
  teacherDashboardAnchors,
  teacherPortalHistoryFloor,
} from "@/lib/db/teacher-portal";
import { formatMoney, formatNumber, formatRating } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { centerLogoSrc } from "@/lib/storage-paths";
import { centreTimeZone } from "@/lib/scheduling";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { LinkButton } from "@/components/shared/link-button";

/**
 * The teacher dashboard (spec §4.2 item 0/1, docs/03 M7): a combined summary
 * across the branches in view — every branch under All branches (U7, the
 * default), or the one the switcher picked — plus one card per branch with
 * that branch's own schedule/earnings, each computed by its own centerId-
 * scoped query (`teacherCenterSummary`) and only *summed* here in memory
 * (docs/01 §4 "Teacher cross-center visibility"). A branch card opens that
 * branch's sessions through the Branch filter — no switching needed.
 */
export default async function TeacherDashboardPage() {
  const scope = await getTeacherScope();
  const contexts = scope.inView;
  const user = scope.user;
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
        user.id,
        today,
        week,
        { from: month.start, to: month.end },
        // U6: the teacher's own history preference, per branch calendar.
        teacherPortalHistoryFloor({ user, settings: centerCtx.settings }, now),
      );
    }),
  );
  const combined = combineTeacherSummaries(summaries);
  const summaryByCenter = new Map(summaries.map((summary) => [summary.centerId, summary]));

  // SEC-15: a teacher's own earnings show per centre under that centre's
  // `analytics.own.view` (TEACHER baseline) — a centre that revokes the cell
  // drops out of the combined figure and its own line hides the amount.
  const earningsVisibleAt = new Set(
    contexts.filter((centerCtx) => ctxCan(centerCtx, "analytics.own.view")).map((centerCtx) => centerCtx.center.id),
  );
  const visibleEarnings = summaries
    .filter((summary) => earningsVisibleAt.has(summary.centerId))
    .reduce((sum, summary) => sum + summary.earnings.teacherShare, 0);

  // M17, spec §5 "Teacher ratings": the same average-out-of-5-only shape
  // every other reader of this aggregate gets — a teacher reading their own
  // rating is never shown a count either, and there is no separate,
  // privileged rating query for this page to call.
  const rating = await teacherRatingAverage(prisma, user.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={
          scope.selected
            ? t("subtitle", { center: scope.selected.center.name })
            : t("subtitleAll", { count: contexts.length })
        }
        // A role is a fact, not an action — and not a status (docs/04 §14.1).
        meta={<Badge variant="neutral">{tRoles("TEACHER")}</Badge>}
      />

      <StatGrid count={earningsVisibleAt.size > 0 ? 5 : 4}>
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
        {earningsVisibleAt.size > 0 ? (
          <StatCard
            label={t("stats.earningsThisMonth")}
            value={formatMoney(visibleEarnings, locale)}
            icon={<Coins className="size-4" />}
          />
        ) : null}
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

            return (
              <div
                key={centerCtx.center.id}
                className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <BrandAvatar
                    name={centerCtx.center.name}
                    logoUrl={centerLogoSrc(centerCtx.center)}
                    themeColor={centerCtx.center.themeColor}
                    size="lg"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{centerCtx.center.name}</p>
                    <p className="mt-1 text-xs text-text-secondary">
                      {t("centers.summary", {
                        // Formatted here: a plain ICU placeholder prints a raw
                        // number in Latin digits in Arabic (docs/04 §3).
                        today: formatNumber(summary?.sessionsToday ?? 0, locale),
                        week: formatNumber(summary?.sessionsThisWeek ?? 0, locale),
                        earnings: earningsVisibleAt.has(centerCtx.center.id)
                          ? formatMoney(summary?.earnings.teacherShare ?? 0, locale)
                          : "—",
                      })}
                    </p>
                  </div>
                </div>

                {/* U7: the branch's own sessions, through the Branch filter. */}
                <LinkButton
                  href={
                    contexts.length > 1
                      ? `${ROUTES.teacherSessions}?branch=${encodeURIComponent(centerCtx.center.id)}`
                      : ROUTES.teacherSessions
                  }
                  className="shrink-0"
                >
                  {t("centers.viewSchedule")}
                </LinkButton>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
