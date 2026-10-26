import { Wallet } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import {
  createExpenseCategoryAction,
  deleteExpenseCategoryAction,
  toggleExpenseCategoryAction,
  updateExpenseCategoryAction,
} from "@/app/[locale]/(center)/expenses/actions";
import { ExpenseForm } from "@/app/[locale]/(center)/expenses/expense-form";
import { ExpenseRow, type ExpenseRowData } from "@/app/[locale]/(center)/expenses/expense-row";
import { ListHeader } from "@/components/shared/list-header";
import { Pagination } from "@/components/center/pagination";
import { DateFilter } from "@/components/shared/date-filter";
import { FilterBar } from "@/components/shared/filter-bar";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import {
  EntityManager,
  type EntityRecord,
} from "@/components/settings/entity-manager";
import type { EntityField } from "@/components/settings/entity-fields";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { expenseTotals } from "@/lib/db/analytics";
import { prisma } from "@/lib/db/client";
import { actorNames } from "@/lib/db/payments";
import { scoped } from "@/lib/db/scoped";
import { clampRangeToVisibility, visibilityWindowFloor } from "@/lib/db/visibility";
import { formatMoney, formatNumber } from "@/lib/format";
import { fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import {
  centreTimeZone,
  dateKey,
  resolveSharedDateFilter,
  todayInTimezone,
} from "@/lib/scheduling";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { expenseFilterSchema } from "@/lib/validation/analytics";
import { toSharedDateFilterInput } from "@/lib/validation/date-filter";
import { ResultsRegion } from "@/components/shared/results-region";

/**
 * Expenses (M6, spec §4.1 item 6): category CRUD, add-expense form, and a
 * filtered, paginated ledger — feeding directly into Analytics' "net" figure
 * (`lib/db/analytics.ts`'s `expenseTotals`, shared rather than recomputed
 * here). `expense.manage` is OWNER/MANAGER only, so a receptionist has no
 * path to this screen at all (spec §3's profit-denial pattern). A voided
 * expense (D-24) stays in the list — struck through, with who voided it, when
 * and why — and is left out of every total.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "expense.manage");

  const rawParams = await searchParams;
  const parsedFilters = expenseFilterSchema.safeParse(rawParams);
  const filters = parsedFilters.success
    ? parsedFilters.data
    : { range: "day" as const, date: null, from: null, to: null };

  // R7b: the centre's calendar day anchors the filter, the floor, the
  // picker's today marker and the add-expense form's default date.
  const now = new Date();
  const timeZone = centreTimeZone(ctx.settings);
  const todayIso = dateKey(todayInTimezone(timeZone, now));
  // Clamped to the data-visibility window (M19, docs/01 §7) before it reaches
  // either the aggregate below or the ledger's own `where`.
  const { start: from, end: to } = clampRangeToVisibility(
    resolveSharedDateFilter(toSharedDateFilterInput(filters), timeZone, now),
    visibilityWindowFloor(ctx, now),
  );

  const db = scoped(ctx);
  const t = await getTranslations("Expenses");
  const locale = await getLocale();

  const [categories, totals] = await Promise.all([
    db.expenseCategories.list(),
    expenseTotals(prisma, ctx.center.id, { from, to }),
  ]);

  const page = parsePageParam(rawParams.page);
  const pageSize = DEFAULT_PAGE_SIZE;
  const where = {
    ...(from || to
      ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db.expenses.search({ where, take: pageSize, skip: (page - 1) * pageSize }),
    db.expenses.count(where),
  ]);

  const voiders = await actorNames(
    prisma,
    ctx.center.id,
    [...new Set(rows.map((expense) => expense.voidedBy).filter((id): id is string => Boolean(id)))],
  );
  const tableRows: ExpenseRowData[] = rows.map((expense) => {
    const voider = expense.voidedBy ? voiders.get(expense.voidedBy) : undefined;
    return {
      id: expense.id,
      date: dateKey(expense.date),
      categoryName: expense.category?.name ?? null,
      amount: expense.amount,
      note: expense.note,
      voided: expense.voided
        ? {
            reason: expense.voidReason,
            at: expense.voidedAt ? expense.voidedAt.toISOString() : null,
            byName: voider ? fullName(voider) : null,
          }
        : null,
    };
  });

  const categoryOptions = categories
    .filter((category) => category.active)
    .map((category) => ({ value: category.id, label: category.name }));

  const categoryFields: EntityField[] = [
    { name: "name", kind: "text", label: t("categories.fields.name"), required: true },
  ];
  const categoryRecords: EntityRecord[] = categories.map((category) => ({
    id: category.id,
    active: category.active,
    values: { name: category.name },
    cells: [category.name],
  }));

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (filters.range !== "day") params.set("range", filters.range);
    if (filters.date) params.set("date", filters.date);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.centerExpenses}?${qs}` : ROUTES.centerExpenses;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <StatGrid count={2}>
        <StatCard
          label={t("stats.total")}
          value={formatMoney(totals.total, locale)}
          icon={<Wallet className="size-4" />}
        />
        <StatCard label={t("stats.count")} value={formatNumber(totals.count, locale)} />
      </StatGrid>

      <Card>
        <CardHeader>
          <CardTitle>{t("addTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ExpenseForm categories={categoryOptions} rowCount={total} todayIso={todayIso} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FilterBar>
            <DateFilter
              value={{
                range: filters.range,
                date: filters.date ?? "",
                from: filters.from ?? "",
                to: filters.to ?? "",
              }}
              todayIso={todayIso}
              resetHref={ROUTES.centerExpenses}
            />
          </FilterBar>

          <ResultsRegion className="flex flex-col gap-4">
            {tableRows.length === 0 ? (
              <EmptyState
                icon={<Wallet />}
                title={t("empty")}
                description={t("emptyHint")}
              />
            ) : (
              <ul className="flex flex-col gap-3 md:gap-0">
                <ListHeader>
                  <span className="w-32 shrink-0">{t("columns.date")}</span>
                  <span className="min-w-0 flex-1">{t("columns.category")}</span>
                  <span className="min-w-0 flex-[2]">{t("columns.note")}</span>
                  <span className="w-32 shrink-0 text-end">{t("columns.amount")}</span>
                  <span className="w-32 shrink-0 text-end">{t("columns.actions")}</span>
                </ListHeader>

                {tableRows.map((expense) => (
                  <ExpenseRow key={expense.id} expense={expense} timeZone={timeZone} />
                ))}
              </ul>
            )}

            <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
          </ResultsRegion>
        </CardContent>
      </Card>

      <SectionHeader title={t("categories.title")} description={t("categories.description")} />
      <EntityManager
        fields={categoryFields}
        records={categoryRecords}
        createAction={createExpenseCategoryAction}
        updateAction={updateExpenseCategoryAction}
        toggleAction={toggleExpenseCategoryAction}
        deleteAction={deleteExpenseCategoryAction}
        labels={{
          addTitle: t("categories.addTitle"),
          addDescription: t("categories.addDescription"),
          listTitle: t("categories.listTitle"),
          listDescription: t("categories.listDescription"),
          empty: t("categories.empty"),
        }}
      />
    </div>
  );
}
