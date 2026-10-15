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
import { PageSection } from "@/components/shared/page-section";
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
import { formatDay, formatMoney, formatNumber, formatTime } from "@/lib/format";
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

  // DES: a row links to its session only for a role that can open it — the
  // accountant's dashboard had linked every row to a page that refused them.
  const canOpenSessions = ctxCan(ctx, "session.view");
  const branchFigures = [
    { key: "staff", label: t("stats.staff"), value: staffCount, Icon: ShieldCheck },
    { key: "teachers", label: t("stats.teachers"), value: teacherCount, Icon: GraduationCap },
    { key: "students", label: t("stats.students"), value: studentCount, Icon: Users },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* The title is the screen; the branch and the day are its description
          and the role is a fact, not an action (docs/04 §14.4). */}
      <PageHeader
        title={t("pageTitle")}
        description={t("pageDescription", { center: ctx.center.name, date: formatDay(today, locale) })}
        meta={<Badge variant="neutral">{tRoles(ctx.role)}</Badge>}
        action={
          /* SEC-2b (D-06): the audit trail, for whoever may read it. */
          ctxCan(ctx, "audit.view") ? (
            <LinkButton href={ROUTES.centerAudit}>{t("auditLink")}</LinkButton>
          ) : undefined
        }
      />

      {/* The order of attention: money, then today's counts. */}
      <PageSection title={t("today.title")}>
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
        <StatGrid count={4} dense>
          <StatCard
            compact
            label={t("today.sessions")}
            value={formatNumber(withStatus.length, locale)}
            icon={<CalendarClock className="size-4" />}
          />
          <StatCard
            compact
            label={t("today.live")}
            value={formatNumber(liveCount, locale)}
            icon={<Radio className="size-4" />}
          />
          <StatCard
            compact
            label={t("today.notStarted")}
            value={formatNumber(notStartedCount, locale)}
            icon={<CircleAlert className="size-4" />}
          />
          <StatCard
            compact
            label={t("today.marked")}
            value={formatNumber(markedToday, locale)}
            zero={markedToday === 0}
            hint={t("today.markedHint", { absent: formatNumber(todayAttendance.ABSENT, locale) })}
          />
        </StatGrid>
      </PageSection>

      <PageSection
        title={t("today.sessionsListTitle")}
        action={
          canOpenSessions ? (
            <LinkButton href={ROUTES.centerSessions} variant="ghost">
              {t("today.viewAll")}
            </LinkButton>
          ) : undefined
        }
      >
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
                  ctxCan(ctx, "class.manage") ? (
                    <LinkButton href={ROUTES.centerClasses}>{t("today.viewClasses")}</LinkButton>
                  ) : undefined
                }
              />
            </CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {withStatus.slice(0, 8).map(({ row, displayStatus }) => {
                const enrolled = row.classGroup?._count.enrollments ?? 0;
                const name = sessionDisplayName(locale, row);
                return (
                  // One column grid shared by every row from md (time · session
                  // · teacher · checked in · status); on a phone the time and
                  // status share the first line, above the name (docs/04 §14.4).
                  <li
                    key={row.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 md:grid-cols-[5.5rem_minmax(0,2fr)_minmax(0,1fr)_9rem_6.5rem] md:gap-4 md:px-5"
                  >
                    <span className="text-sm tabular-nums text-text-secondary md:order-1">
                      {formatTime(row.startTime, locale)}
                    </span>
                    <span className="justify-self-end md:order-5">
                      <Badge variant={STATUS_BADGE[displayStatus]} pulse={displayStatus === "LIVE"}>
                        {tStatus(displayStatus)}
                      </Badge>
                    </span>
                    {canOpenSessions ? (
                      <Link
                        href={ROUTES.centerSession(row.id)}
                        className="col-span-2 min-w-0 truncate rounded-sm text-sm font-medium text-text-primary focus-ring hover:text-brand hover:underline md:order-2 md:col-span-1"
                      >
                        {name}
                      </Link>
                    ) : (
                      <span className="col-span-2 min-w-0 truncate text-sm font-medium text-text-primary md:order-2 md:col-span-1">
                        {name}
                      </span>
                    )}
                    <span className="min-w-0 truncate text-sm text-text-secondary md:order-3" dir="auto">
                      {teacherNameByUserId.get(row.teacherId) ?? "—"}
                    </span>
                    <span className="text-end text-sm whitespace-nowrap tabular-nums text-text-secondary md:order-4">
                      {/* A one-time session (R5) has no class and no enrolled count. */}
                      {enrolled > 0
                        ? t("today.checkedInOf", {
                            count: formatNumber(row._count.attendees, locale),
                            total: formatNumber(enrolled, locale),
                          })
                        : t("today.checkedIn", { count: formatNumber(row._count.attendees, locale) })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </PageSection>

      {/* Head-counts change slowly: one compact strip, not three big cards. */}
      <PageSection title={t("center.title")}>
        <Card className="gap-0 py-0">
          <dl className="grid grid-cols-3">
            {branchFigures.map(({ key, label, value, Icon }) => (
              <div
                key={key}
                className="flex min-w-0 flex-col gap-1 border-s border-border px-4 py-3 first:border-s-0 md:px-5 md:py-4"
              >
                <dt className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{label}</span>
                </dt>
                <dd className="text-2xl font-bold tabular-nums text-text-primary">
                  {formatNumber(value, locale)}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </PageSection>
    </div>
  );
}
