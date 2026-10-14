import { Banknote, GraduationCap, TrendingUp, UserPlus, Users, Wallet } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { BranchRevenueTable } from "@/app/[locale]/(center)/analytics/branch-revenue-table";
import { TeacherFilter } from "@/app/[locale]/(center)/analytics/teacher-filter";
import { TeacherRevenueTable } from "@/app/[locale]/(center)/analytics/teacher-revenue-table";
import { DateFilter } from "@/components/shared/date-filter";
import { FilterBar } from "@/components/shared/filter-bar";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { LinkButton } from "@/components/shared/link-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  ctxCan,
  getOwnerOrgGroups,
  getTenantContext,
  getUserCenterRelations,
  requirePermission,
} from "@/lib/auth/tenant";
import { can } from "@/lib/auth/permissions";
import { roleForExperience } from "@/lib/auth/relations";
import { loadPermissionGrants } from "@/lib/db/permissions";
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
import {
  centreTimeZone,
  dateKey,
  resolveSharedDateFilter,
  todayInTimezone,
} from "@/lib/scheduling";
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

  // R7b: "today" is the active centre's calendar day. The "Whole Management"
  // rollup below shares this one `range` across every branch (a single
  // combined value is unavoidable there), so it is resolved once against the
  // *active* branch's timezone — the viewing context's own rule — and applied
  // to each branch's scoped query unchanged. Branches are Egyptian centres on
  // one timezone in practice; `check:timezone` pins the rule.
  const now = new Date();
  const timeZone = centreTimeZone(ctx.settings);
  // Clamped to the data-visibility window (M19, docs/01 §7) before it ever
  // reaches a query — covers the rollup path below too, since both branches
  // share this same `range`.
  const { start: from, end: to } = clampRangeToVisibility(
    resolveSharedDateFilter(toSharedDateFilterInput(filters), timeZone, now),
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

  // SEC-48: every branch in the roll-up is read under **its own** rules —
  // the viewer must hold `analytics.center.view` at that branch, and its rows
  // are clamped to that branch's own data-visibility window (its own
  // settings, read one branch at a time — never a cross-centre query).
  const rollupBranches = orgGroup
    ? (
        await Promise.all(
          orgGroup.branches.map(async (branch) => {
            const relation = (await getUserCenterRelations(ctx.user.id)).find(
              (item) => item.center.id === branch.id,
            );
            const role = relation ? roleForExperience(relation, "center") : null;
            if (!role || role === "STUDENT") return null;
            const grants = await loadPermissionGrants(prisma, branch.id, role);
            if (!can(role, "analytics.center.view", grants)) return null;
            const settings = await prisma.centerSettings.findUnique({ where: { centerId: branch.id } });
            const { start, end } = clampRangeToVisibility(
              resolveSharedDateFilter(toSharedDateFilterInput(filters), timeZone, now),
              visibilityWindowFloor({ isPlatformAdmin: ctx.isPlatformAdmin, settings }, now),
            );
            return { branch, range: { from: start, to: end } };
          }),
        )
      ).filter((row): row is NonNullable<typeof row> => row !== null)
    : null;
  const rollupBranchIds = rollupBranches?.map((row) => row.branch.id) ?? null;
  const rollupRanges = new Map(rollupBranches?.map((row) => [row.branch.id, row.range]) ?? []);

  const [revenue, expenses, students, teachers, byTeacher, teacherMemberships, byBranch] =
    await Promise.all([
      rollupBranchIds
        ? revenueTotalsRollup(prisma, rollupBranchIds, rollupRanges, filters.teacherId)
        : revenueTotals(prisma, centerId, range, filters.teacherId),
      rollupBranchIds
        ? expenseTotalsRollup(prisma, rollupBranchIds, rollupRanges)
        : expenseTotals(prisma, centerId, range),
      rollupBranchIds
        ? studentCountsRollup(prisma, rollupBranchIds, rollupRanges)
        : studentCounts(prisma, centerId, range),
      rollupBranchIds
        ? teacherCountsRollup(prisma, rollupBranchIds, rollupRanges)
        : teacherCounts(prisma, centerId, range),
      filters.teacherId || rollupBranchIds
        ? Promise.resolve([])
        : revenueByTeacher(prisma, centerId, range),
      scoped(ctx).teachers.list({ active: true }),
      rollupBranchIds
        ? revenueByBranch(prisma, rollupBranches!.map((row) => row.branch), rollupRanges)
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
          orgGroup || ctxCan(ctx, "audit.view") ? (
            <div className="flex flex-wrap items-center gap-2">
              {orgGroup ? (
                <Badge variant="brand">
                  {t("rollup.badge", { organization: orgGroup.organizationName })}
                </Badge>
              ) : null}
              {/* SEC-2b (D-06): voids, refunds and unpaid check-ins live here. */}
              {ctxCan(ctx, "audit.view") ? (
                <LinkButton href={ROUTES.centerAudit}>{t("auditLink")}</LinkButton>
              ) : null}
            </div>
          ) : undefined
        }
      />

      {/* One filter row (docs/04 §5 "Filter row"): the date control and the
          teacher select are labelled fields on one baseline. The date control
          is the page's only date affordance (§11.7). */}
      <Card>
        <CardContent>
          <FilterBar>
            <DateFilter
              value={{
                range: filters.range,
                date: filters.date ?? "",
                from: filters.from ?? "",
                to: filters.to ?? "",
              }}
              todayIso={dateKey(todayInTimezone(timeZone, now))}
              resetHref={ROUTES.centerAnalytics}
            />
            <TeacherFilter teacherId={filters.teacherId ?? ""} teachers={teacherOptions} />
          </FilterBar>
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
              zero={expenses.total === 0}
              zeroLabel={t("zeroHint")}
            />
            <StatCard
              label={t("revenue.net")}
              value={formatMoney(net, locale)}
              icon={<TrendingUp className="size-4" />}
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
            <CardContent>
              <BranchRevenueTable rows={byBranch} showProfit={showProfit} locale={locale} />
            </CardContent>
          </Card>
        </>
      ) : null}

      {!filters.teacherId && !orgGroup ? (
        <>
          <SectionHeader title={t("byTeacher.title")} description={t("byTeacher.description")} />
          <Card>
            <CardContent>
              <TeacherRevenueTable rows={breakdownRows} showProfit={showProfit} locale={locale} />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
