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
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { attendanceStatusCounts, revenueTotals } from "@/lib/db/analytics";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { deriveSessionDisplayStatus, sessionDisplayName } from "@/lib/db/sessions";
import { formatMoney, formatNumber } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { startOfUtcDay } from "@/lib/scheduling";

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
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

  const today = startOfUtcDay(new Date());
  const todayRange = { from: today, to: today };

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

  const now = new Date();
  const teacherNameByUserId = new Map(
    teacherMemberships.map((teacher) => [teacher.userId, fullName(localName(teacher, teacher.user))]),
  );
  const withStatus = todaySessions
    .map((row) => ({ row, displayStatus: deriveSessionDisplayStatus(row, now) }))
    .sort((a, b) => a.row.startTime.localeCompare(b.row.startTime));

  const liveCount = withStatus.filter((entry) => entry.displayStatus === "LIVE").length;
  const notStartedCount = withStatus.filter((entry) => entry.displayStatus === "SCHEDULED").length;
  const markedToday = todayAttendance.PRESENT + todayAttendance.LATE + todayAttendance.ABSENT + todayAttendance.EXCUSED;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title", { center: ctx.center.name })}
        description={t("subtitle")}
        action={<Badge variant="brand">{tRoles(ctx.role)}</Badge>}
      />

      <SectionHeader title={t("today.title")} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("today.sessions")}
          value={formatNumber(withStatus.length, locale)}
          icon={<CalendarClock className="size-4" />}
        />
        <StatCard
          label={t("today.live")}
          value={formatNumber(liveCount, locale)}
          icon={<Radio className="size-4" />}
          accent="success"
        />
        <StatCard
          label={t("today.notStarted")}
          value={formatNumber(notStartedCount, locale)}
          icon={<CircleAlert className="size-4" />}
          accent="warning"
        />
        <StatCard
          label={t("today.marked")}
          value={formatNumber(markedToday, locale)}
          hint={t("today.markedHint", { absent: formatNumber(todayAttendance.ABSENT, locale) })}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label={t("today.collected")}
          value={formatMoney(todayRevenue.collected, locale)}
          icon={<Wallet className="size-4" />}
          accent="brand"
        />
        {showProfit ? (
          <StatCard
            label={t("today.centerShare")}
            value={formatMoney(todayRevenue.centerShare, locale)}
          />
        ) : null}
      </div>

      <SectionHeader title={t("today.sessionsListTitle")} action={
        <Link href={ROUTES.centerSessions} className="text-sm font-medium text-brand hover:underline">
          {t("today.viewAll")}
        </Link>
      } />
      <Card>
        <CardContent className="pt-6">
          {withStatus.length === 0 ? (
            <p className="text-sm text-text-muted">{t("today.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              {withStatus.slice(0, 8).map(({ row, displayStatus }) => (
                <li
                  key={row.id}
                  className="flex flex-col gap-2 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3 md:last:border-0"
                >
                  <span className="w-16 shrink-0 text-sm tabular-nums text-text-secondary" dir="ltr">
                    {row.startTime}
                  </span>
                  <Link
                    href={ROUTES.centerSession(row.id)}
                    className="min-w-0 flex-1 truncate text-sm font-medium text-brand hover:underline"
                  >
                    {sessionDisplayName(row)}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">
                    {teacherNameByUserId.get(row.teacherId) ?? "—"}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-text-secondary">
                    {formatNumber(row._count.attendees, locale)}
                    {row.classGroup._count.enrollments > 0
                      ? ` / ${formatNumber(row.classGroup._count.enrollments, locale)}`
                      : ""}
                  </span>
                  <Badge variant={STATUS_BADGE[displayStatus]}>{tStatus(displayStatus)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <SectionHeader title={t("center.title")} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
      </div>
    </div>
  );
}
