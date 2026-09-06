import { Banknote, GraduationCap, TrendingUp, UserPlus, Users, Wallet } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { TeacherFilter } from "@/app/[locale]/(center)/analytics/teacher-filter";
import { TeacherRevenueTable } from "@/app/[locale]/(center)/analytics/teacher-revenue-table";
import { DateRangeFilters } from "@/components/shared/date-range-filters";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import { Card, CardContent } from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import {
  expenseTotals,
  revenueByTeacher,
  revenueTotals,
  studentCounts,
  teacherCounts,
} from "@/lib/db/analytics";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { formatMoney, formatNumber } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { resolveDateRangeUtc, startOfUtcDay } from "@/lib/scheduling";
import { analyticsFilterSchema } from "@/lib/validation/analytics";

/**
 * Analytics (M6, spec §4.1 item 5): date filters (day/week/month/year/
 * all-time/specific date) + by-teacher breakdown, all read from the frozen
 * `Payment` snapshots via `lib/db/analytics.ts` (docs/01 §3 — never
 * recomputed from the class's current price/cut). Gated behind
 * `analytics.center.view`, OWNER/MANAGER only — a receptionist has no path to
 * this screen at all, by UI or by URL (spec §7 acceptance criterion 9).
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "analytics.center.view");
  const showProfit = ctxCan(ctx, "center.profit.view");

  const rawParams = await searchParams;
  const parsedFilters = analyticsFilterSchema.safeParse(rawParams);
  const filters = parsedFilters.success
    ? parsedFilters.data
    : { range: "month" as const, date: null, teacherId: null };

  const anchor = filters.date
    ? new Date(`${filters.date}T00:00:00.000Z`)
    : startOfUtcDay(new Date());

  const { start: from, end: to } = resolveDateRangeUtc(filters.range, anchor);

  const t = await getTranslations("Analytics");
  const locale = await getLocale();
  const centerId = ctx.center.id;
  const range = { from, to };

  const [revenue, expenses, students, teachers, byTeacher, teacherMemberships] =
    await Promise.all([
      revenueTotals(prisma, centerId, range, filters.teacherId),
      expenseTotals(prisma, centerId, range),
      studentCounts(prisma, centerId, range),
      teacherCounts(prisma, centerId, range),
      filters.teacherId ? Promise.resolve([]) : revenueByTeacher(prisma, centerId, range),
      scoped(ctx).teachers.list({ active: true }),
    ]);

  const net = revenue.centerShare - expenses.total;
  const daysInRange =
    from && to ? Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1) : null;
  const avgPerPayment = revenue.paymentCount > 0 ? Math.round(revenue.collected / revenue.paymentCount) : 0;
  const avgPerDay = daysInRange ? Math.round(revenue.collected / daysInRange) : null;

  const teacherNameByUserId = new Map(
    teacherMemberships.map((teacher) => [teacher.userId, fullName(localName(teacher, teacher.user))]),
  );
  const teacherOptions = teacherMemberships.map((teacher) => ({
    value: teacher.userId,
    label: fullName(localName(teacher, teacher.user)),
  }));
  const breakdownRows = byTeacher.map((row) => ({
    ...row,
    teacherName: teacherNameByUserId.get(row.teacherId) ?? t("byTeacher.unknown"),
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardContent className="pt-6">
          <DateRangeFilters
            range={filters.range}
            date={filters.date ?? anchor.toISOString().slice(0, 10)}
            namespace="Analytics"
          >
            <TeacherFilter teacherId={filters.teacherId ?? ""} teachers={teacherOptions} />
          </DateRangeFilters>
        </CardContent>
      </Card>

      <SectionHeader title={t("revenue.title")} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("revenue.collected")}
          value={formatMoney(revenue.collected, locale)}
          icon={<Wallet className="size-4" />}
          accent="brand"
        />
        {showProfit ? (
          <>
            <StatCard label={t("revenue.centerShare")} value={formatMoney(revenue.centerShare, locale)} />
            <StatCard label={t("revenue.teacherShare")} value={formatMoney(revenue.teacherShare, locale)} />
            <StatCard
              label={t("revenue.expenses")}
              value={formatMoney(expenses.total, locale)}
              accent="danger"
            />
            <StatCard
              label={t("revenue.net")}
              value={formatMoney(net, locale)}
              icon={<TrendingUp className="size-4" />}
              accent={net >= 0 ? "success" : "danger"}
            />
          </>
        ) : null}
        <StatCard
          label={t("revenue.avgPerPayment")}
          value={formatMoney(avgPerPayment, locale)}
          icon={<Banknote className="size-4" />}
        />
        {avgPerDay !== null ? (
          <StatCard label={t("revenue.avgPerDay")} value={formatMoney(avgPerDay, locale)} />
        ) : null}
      </div>

      <SectionHeader title={t("users.title")} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("users.totalStudents")}
          value={formatNumber(students.total, locale)}
          icon={<Users className="size-4" />}
        />
        <StatCard
          label={t("users.newStudents")}
          value={formatNumber(students.new, locale)}
          icon={<UserPlus className="size-4" />}
        />
        <StatCard
          label={t("users.totalTeachers")}
          value={formatNumber(teachers.total, locale)}
          icon={<GraduationCap className="size-4" />}
        />
        <StatCard label={t("users.activeTeachers")} value={formatNumber(teachers.active, locale)} />
        <StatCard label={t("users.newTeachers")} value={formatNumber(teachers.new, locale)} />
      </div>

      {!filters.teacherId ? (
        <>
          <SectionHeader title={t("byTeacher.title")} description={t("byTeacher.description")} />
          <Card>
            <CardContent className="pt-6">
              <TeacherRevenueTable rows={breakdownRows} showProfit={showProfit} locale={locale} />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
