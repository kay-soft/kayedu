import { Banknote, GraduationCap, TrendingUp, UserPlus, Users, Wallet } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { BranchRevenueTable } from "@/app/[locale]/(center)/analytics/branch-revenue-table";
import { TeacherFilter } from "@/app/[locale]/(center)/analytics/teacher-filter";
import { TeacherRevenueTable } from "@/app/[locale]/(center)/analytics/teacher-revenue-table";
import { DateFilter } from "@/components/shared/date-filter";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  ctxCan,
  getOwnerOrgGroups,
  getTenantContext,
  requirePermission,
} from "@/lib/auth/tenant";
import {
  expenseTotals,
  revenueByTeacher,
  revenueTotals,
  studentCounts,
  teacherCounts,
} from "@/lib/db/analytics";
import { prisma } from "@/lib/db/client";
import {
  expenseTotalsRollup,
  revenueByBranch,
  revenueTotalsRollup,
  studentCountsRollup,
  teacherCountsRollup,
} from "@/lib/db/organizations";
import { scoped } from "@/lib/db/scoped";
import { clampRangeToVisibility, visibilityWindowFloor } from "@/lib/db/visibility";
import { formatMoney, formatNumber } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { resolveSharedDateFilter, startOfUtcDay } from "@/lib/scheduling";
import { analyticsFilterSchema } from "@/lib/validation/analytics";
import { toSharedDateFilterInput } from "@/lib/validation/date-filter";
import { ROUTES } from "@/lib/routes";

/**
 * Analytics (M6, spec §4.1 item 5): the shared date filter (M18, day/week/
 * month/specific date/range) + by-teacher breakdown, all read from the frozen
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
    : { range: "day" as const, date: null, from: null, to: null, teacherId: null };

  const now = new Date();
  // Clamped to the data-visibility window (M19, docs/01 §7) before it ever
  // reaches a query — covers the rollup path below too, since both branches
  // share this same `range`.
  const { start: from, end: to } = clampRangeToVisibility(
    resolveSharedDateFilter(toSharedDateFilterInput(filters), now),
    visibilityWindowFloor(ctx, now),
  );

  const t = await getTranslations("Analytics");
  const locale = await getLocale();
  const centerId = ctx.center.id;
  const range = { from, to };

  // "Whole Management" (M11): an Owner viewing every branch under their
  // organization instead of just the active one. `ctx.rollupOrganizationId`
  // is set by `getTenantContext()` when the active-selection cookie named an
  // Organization rather than a branch (lib/auth/active-center.ts) — the same
  // single cookie/flow `/select-center` always used, just resolving to two
  // different kinds of id. This never widens centerId-scoping — it is a
  // union of independent per-branch scoped queries summed in memory
  // (lib/db/organizations.ts), exactly like the teacher portal's combined
  // dashboard (docs/01-data-model.md §4).
  const orgGroups = ctx.rollupOrganizationId
    ? await getOwnerOrgGroups(ctx.user.id)
    : [];
  const orgGroup = orgGroups.find(
    (group) => group.organizationId === ctx.rollupOrganizationId,
  );
  const rollupBranchIds = orgGroup?.branches.map((branch) => branch.id) ?? null;

  const [revenue, expenses, students, teachers, byTeacher, teacherMemberships, byBranch] =
    await Promise.all([
      rollupBranchIds
        ? revenueTotalsRollup(prisma, rollupBranchIds, range, filters.teacherId)
        : revenueTotals(prisma, centerId, range, filters.teacherId),
      rollupBranchIds
        ? expenseTotalsRollup(prisma, rollupBranchIds, range)
        : expenseTotals(prisma, centerId, range),
      rollupBranchIds
        ? studentCountsRollup(prisma, rollupBranchIds, range)
        : studentCounts(prisma, centerId, range),
      rollupBranchIds
        ? teacherCountsRollup(prisma, rollupBranchIds, range)
        : teacherCounts(prisma, centerId, range),
      filters.teacherId || rollupBranchIds
        ? Promise.resolve([])
        : revenueByTeacher(prisma, centerId, range),
      scoped(ctx).teachers.list({ active: true }),
      rollupBranchIds
        ? revenueByBranch(prisma, orgGroup!.branches, range)
        : Promise.resolve([]),
    ]);

  const net = revenue.centerShare - expenses.total;
  const daysInRange =
    from && to ? Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1) : null;
  const avgPerPayment = revenue.paymentCount > 0 ? Math.round(revenue.collected / revenue.paymentCount) : 0;
  const avgPerDay = daysInRange ? Math.round(revenue.collected / daysInRange) : null;

  // "Nothing was collected in this range" is a different answer from
  // "something is broken", and a wall of bold EGP 0 says the second one
  // (docs/04 §5 "KPI / stat card").
  const noRevenue = revenue.paymentCount === 0;
  // The second revenue row's card count, so `StatGrid` can pick a column
  // arrangement that divides evenly instead of leaving an orphan tile.
  const secondaryCount = (showProfit ? 2 : 0) + 1 + (avgPerDay !== null ? 1 : 0);

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
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        action={
          orgGroup ? (
            <Badge variant="brand">
              {t("rollup.badge", { organization: orgGroup.organizationName })}
            </Badge>
          ) : undefined
        }
      />

      {/* One row, one baseline (docs/04 §11.7). The date control is a single
          control now rather than a segmented row plus two browser date
          fields, so the teacher select sits directly beside it instead of
          floating between two competing affordances. Below `sm` the two
          stack, each full-width. */}
      <Card>
        <CardContent className="py-4">
          <form className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <DateFilter
              value={{
                range: filters.range,
                date: filters.date ?? "",
                from: filters.from ?? "",
                to: filters.to ?? "",
              }}
              todayIso={startOfUtcDay(now).toISOString().slice(0, 10)}
              resetHref={ROUTES.centerAnalytics}
            />
            <TeacherFilter teacherId={filters.teacherId ?? ""} teachers={teacherOptions} />
          </form>
        </CardContent>
      </Card>

      {/* Two rows, split by meaning: what came in, then what it left behind.
          Seven cards in one four-wide grid left an orphan row of three
          (docs/04 §5 "KPI grid"). `StatGrid` picks the columns from the
          count, so neither row can wrap into an orphan at any breakpoint. */}
      <SectionHeader title={t("revenue.title")} />
      <StatGrid count={showProfit ? 3 : 1}>
        <StatCard
          label={t("revenue.collected")}
          value={formatMoney(revenue.collected, locale)}
          icon={<Wallet className="size-4" />}
          accent="brand"
          zero={noRevenue}
          zeroLabel={t("zeroHint")}
        />
        {showProfit ? (
          <>
            <StatCard
              label={t("revenue.centerShare")}
              value={formatMoney(revenue.centerShare, locale)}
              zero={noRevenue}
              zeroLabel={t("zeroHint")}
            />
            <StatCard
              label={t("revenue.teacherShare")}
              value={formatMoney(revenue.teacherShare, locale)}
              zero={noRevenue}
              zeroLabel={t("zeroHint")}
            />
          </>
        ) : null}
      </StatGrid>

      <StatGrid count={secondaryCount}>
        {showProfit ? (
          <>
            <StatCard
              label={t("revenue.expenses")}
              value={formatMoney(expenses.total, locale)}
              accent="danger"
              zero={expenses.total === 0}
              zeroLabel={t("zeroHint")}
            />
            <StatCard
              label={t("revenue.net")}
              value={formatMoney(net, locale)}
              icon={<TrendingUp className="size-4" />}
              accent={net >= 0 ? "success" : "danger"}
              zero={noRevenue && expenses.total === 0}
              zeroLabel={t("zeroHint")}
            />
          </>
        ) : null}
        <StatCard
          label={t("revenue.avgPerPayment")}
          value={formatMoney(avgPerPayment, locale)}
          icon={<Banknote className="size-4" />}
          zero={noRevenue}
          zeroLabel={t("zeroHint")}
        />
        {avgPerDay !== null ? (
          <StatCard
            label={t("revenue.avgPerDay")}
            value={formatMoney(avgPerDay, locale)}
            zero={noRevenue}
            zeroLabel={t("zeroHint")}
          />
        ) : null}
      </StatGrid>

      {/* Two cards about students, three about teachers — five in one
          four-wide grid stranded a single tile on its own row. */}
      <SectionHeader title={t("users.title")} />
      <StatGrid count={2}>
        <StatCard
          label={t("users.totalStudents")}
          value={formatNumber(students.total, locale)}
          icon={<Users className="size-4" />}
        />
        <StatCard
          label={t("users.newStudents")}
          value={formatNumber(students.new, locale)}
          icon={<UserPlus className="size-4" />}
          zero={students.new === 0}
          zeroLabel={t("zeroHint")}
        />
      </StatGrid>
      <StatGrid count={3}>
        <StatCard
          label={t("users.totalTeachers")}
          value={formatNumber(teachers.total, locale)}
          icon={<GraduationCap className="size-4" />}
        />
        <StatCard label={t("users.activeTeachers")} value={formatNumber(teachers.active, locale)} />
        <StatCard
          label={t("users.newTeachers")}
          value={formatNumber(teachers.new, locale)}
          zero={teachers.new === 0}
          zeroLabel={t("zeroHint")}
        />
      </StatGrid>

      {orgGroup ? (
        <>
          <SectionHeader title={t("byBranch.title")} description={t("byBranch.description")} />
          <Card>
            <CardContent className="pt-6">
              <BranchRevenueTable rows={byBranch} showProfit={showProfit} locale={locale} />
            </CardContent>
          </Card>
        </>
      ) : null}

      {!filters.teacherId && !orgGroup ? (
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
