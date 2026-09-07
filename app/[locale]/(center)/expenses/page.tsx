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
import { Pagination } from "@/components/center/pagination";
import { DateFilter } from "@/components/shared/date-filter";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { StatCard } from "@/components/shared/stat-card";
import {
  EntityManager,
  type EntityRecord,
} from "@/components/settings/entity-manager";
import type { EntityField } from "@/components/settings/entity-fields";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { expenseTotals } from "@/lib/db/analytics";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { formatMoney, formatNumber } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { resolveSharedDateFilter, startOfUtcDay } from "@/lib/scheduling";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { expenseFilterSchema } from "@/lib/validation/analytics";
import { toSharedDateFilterInput } from "@/lib/validation/date-filter";

/**
 * Expenses (M6, spec §4.1 item 6): category CRUD, add-expense form, and a
 * filtered, paginated ledger — feeding directly into Analytics' "net" figure
 * (`lib/db/analytics.ts`'s `expenseTotals`, shared rather than recomputed
 * here). `expense.manage` is OWNER/MANAGER only, so a receptionist has no
 * path to this screen at all (spec §3's profit-denial pattern).
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

  const now = new Date();
  const { start: from, end: to } = resolveSharedDateFilter(
    toSharedDateFilterInput(filters),
    now,
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

  const tableRows: ExpenseRowData[] = rows.map((expense) => ({
    id: expense.id,
    date: expense.date.toISOString().slice(0, 10),
    categoryName: expense.category?.name ?? null,
    amount: expense.amount,
    note: expense.note,
  }));

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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label={t("stats.total")}
          value={formatMoney(totals.total, locale)}
          icon={<Wallet className="size-4" />}
          accent="danger"
        />
        <StatCard label={t("stats.count")} value={formatNumber(totals.count, locale)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("addTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ExpenseForm categories={categoryOptions} rowCount={total} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form>
            <DateFilter
              value={{
                range: filters.range,
                date: filters.date ?? "",
                from: filters.from ?? "",
                to: filters.to ?? "",
              }}
              todayIso={startOfUtcDay(now).toISOString().slice(0, 10)}
              resetHref={ROUTES.centerExpenses}
            />
          </form>

          {tableRows.length === 0 ? (
            <p className="text-sm text-text-muted">{t("empty")}</p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              <li
                aria-hidden
                className="hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex"
              >
                <span className="w-32 shrink-0">{t("columns.date")}</span>
                <span className="min-w-0 flex-1">{t("columns.category")}</span>
                <span className="min-w-0 flex-[2]">{t("columns.note")}</span>
                <span className="w-28 shrink-0">{t("columns.amount")}</span>
                <span className="w-32 shrink-0 text-end">{t("columns.actions")}</span>
              </li>

              {tableRows.map((expense) => (
                <ExpenseRow key={expense.id} expense={expense} />
              ))}
            </ul>
          )}

          <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
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
