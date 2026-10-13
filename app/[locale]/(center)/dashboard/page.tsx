import { getLocale, getTranslations } from "next-intl/server";
import {
  CalendarClock,
  CircleAlert,
  GraduationCap,
  Radio,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { attendanceStatusCounts, revenueTotals } from "@/lib/db/analytics";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { deriveSessionDisplayStatus } from "@/lib/db/sessions";
import { sessionDisplayName } from "@/lib/session-label";
import { formatMoney, formatNumber, formatTime } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone, todayInTimezone } from "@/lib/scheduling";
import { closeEndedSessions } from "@/lib/db/session-lifecycle";

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

/**
 * The Center Dashboard (spec §4.1 item 1 — not assigned to any prior
 * milestone; it lands here in M6 alongside Analytics/Expenses because it
 * shares the exact same revenue/attendance aggregation queries, just with a
 * "today" date-range default instead of Analytics' day/week/month/year/all
 * (`lib/db/analytics.ts`, docs/02 §14). No permission gate of its own — every
 * center-staff role lands here — but the profit-bearing figures are hidden
 * for a role without `center.profit.view`, the same pattern as the M5
 * session receipt (spec §7 acceptance criterion 9).
 */
export default async function CenterDashboardPage() {
  const ctx = await getTenantContext("center");
  const db = scoped(ctx);
  const locale = await getLocale();
  const t = await getTranslations("CenterDashboard");
  const tRoles = await getTranslations("Roles");
  const tStatus = await getTranslations("Sessions.status");
  const showProfit = ctxCan(ctx, "center.profit.view");

  // R7b: one `now`, one centre-timezone "today" for the whole page.
  const now = new Date();
  const timeZone = centreTimeZone(ctx.settings);
  const today = todayInTimezone(timeZone, now);
  const todayRange = { from: today, to: today };
  // R2's lazy end-of-day close: any earlier session nobody ended is closed
  // (AUTO, absences materialized) before the day's numbers are read.
  await closeEndedSessions(prisma, ctx.center.id, now);

  const [
    staffCount,
    teacherCount,
    studentCount,
    todaySessions,
    teacherMemberships,
    todayRevenue,
    todayAttendance,
  ] = await Promise.all([
    db.memberships.count({
      active: true,
      role: { in: ["OWNER", "MANAGER", "RECEPTIONIST"] },
    }),
    db.memberships.count({ active: true, role: "TEACHER" }),
    db.students.count({ active: true }),
    db.sessions.listForDay(today),
    db.teachers.list({ active: true }),
    revenueTotals(prisma, ctx.center.id, todayRange),
    attendanceStatusCounts(prisma, ctx.center.id, todayRange),
  ]);

  const teacherNameByUserId = new Map(
    teacherMemberships.map((teacher) => [teacher.userId, fullName(localName(teacher, teacher.user))]),
  );
  const withStatus = todaySessions
    .map((row) => ({ row, displayStatus: deriveSessionDisplayStatus(row, now, timeZone) }))
    .sort((a, b) => a.row.startTime.localeCompare(b.row.startTime));

  const liveCount = withStatus.filter((entry) => entry.displayStatus === "LIVE").length;
  const notStartedCount = withStatus.filter((entry) => entry.displayStatus === "SCHEDULED").length;
  const markedToday = todayAttendance.PRESENT + todayAttendance.LATE + todayAttendance.ABSENT;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title", { center: ctx.center.name })}
        description={t("subtitle")}
        action={<Badge variant="brand">{tRoles(ctx.role)}</Badge>}
      />

      <SectionHeader title={t("today.title")} />
      <StatGrid count={4}>
        <StatCard
          label={t("today.sessions")}
          value={formatNumber(withStatus.length, locale)}
          icon={<CalendarClock className="size-4" />}
        />
        <StatCard
          label={t("today.live")}
          value={formatNumber(liveCount, locale)}
          icon={<Radio className="size-4" />}
        />
        <StatCard
          label={t("today.notStarted")}
          value={formatNumber(notStartedCount, locale)}
          icon={<CircleAlert className="size-4" />}
        />
        <StatCard
          label={t("today.marked")}
          value={formatNumber(markedToday, locale)}
          zero={markedToday === 0}
          zeroLabel={t("zeroHint")}
          hint={t("today.markedHint", { absent: formatNumber(todayAttendance.ABSENT, locale) })}
        />
      </StatGrid>

      <StatGrid count={showProfit ? 2 : 1}>
        <StatCard
          label={t("today.collected")}
          value={formatMoney(todayRevenue.collected, locale)}
          icon={<Wallet className="size-4" />}
          zero={todayRevenue.paymentCount === 0}
          zeroLabel={t("zeroHint")}
        />
        {showProfit ? (
          <StatCard
            label={t("today.centerShare")}
            value={formatMoney(todayRevenue.centerShare, locale)}
            zero={todayRevenue.paymentCount === 0}
            zeroLabel={t("zeroHint")}
          />
        ) : null}
      </StatGrid>

      <SectionHeader
        title={t("today.sessionsListTitle")}
        action={
          <LinkButton href={ROUTES.centerSessions} variant="ghost" size="sm">
            {t("today.viewAll")}
          </LinkButton>
        }
      />
      {/* The card gives up its own vertical padding: rows carry theirs, so the
          first and last row sit an even 12px from the border instead of
          stacking card padding on top of row padding. */}
      <Card className="gap-0 py-0">
        {withStatus.length === 0 ? (
          <CardContent className="p-4">
            <EmptyState
              compact
              icon={<CalendarClock />}
              title={t("today.empty")}
              description={t("emptyHint")}
              action={
                <LinkButton href={ROUTES.centerClasses} size="sm">
                  {t("today.viewClasses")}
                </LinkButton>
              }
            />
          </CardContent>
        ) : (
          <ul className="divide-y divide-border">
            {withStatus.slice(0, 8).map(({ row, displayStatus }) => (
              <li
                key={row.id}
                className="flex flex-col gap-1.5 px-4 py-3 md:flex-row md:items-center md:gap-4"
              >
                <span className="text-sm tabular-nums text-text-secondary md:w-20 md:shrink-0" dir="ltr">
                  {formatTime(row.startTime, locale)}
                </span>
                <Link
                  href={ROUTES.centerSession(row.id)}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary hover:text-brand hover:underline focus-ring rounded-sm"
                >
                  {sessionDisplayName(locale, row)}
                </Link>
                <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">
                  {teacherNameByUserId.get(row.teacherId) ?? "—"}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-text-secondary">
                  {formatNumber(row._count.attendees, locale)}
                  {/* A one-time session (R5) has no class and no enrolled count. */}
                  {(row.classGroup?._count.enrollments ?? 0) > 0
                    ? ` / ${formatNumber(row.classGroup?._count.enrollments ?? 0, locale)}`
                    : ""}
                </span>
                <Badge variant={STATUS_BADGE[displayStatus]}>{tStatus(displayStatus)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <SectionHeader title={t("center.title")} />
      <StatGrid count={3}>
        <StatCard
          label={t("stats.staff")}
          value={formatNumber(staffCount, locale)}
          icon={<ShieldCheck className="size-4" />}
        />
        <StatCard
          label={t("stats.teachers")}
          value={formatNumber(teacherCount, locale)}
          icon={<GraduationCap className="size-4" />}
        />
        <StatCard
          label={t("stats.students")}
          value={formatNumber(studentCount, locale)}
          icon={<Users className="size-4" />}
        />
      </StatGrid>
    </div>
  );
}
