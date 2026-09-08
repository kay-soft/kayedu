import { getTranslations } from "next-intl/server";
import { ChartNoAxesColumn } from "lucide-react";

import { formatMoney, formatNumber } from "@/lib/format";
import { EmptyState } from "@/components/shared/empty-state";

export type BranchRevenueRowData = {
  branchId: string;
  branchName: string;
  collected: number;
  centerShare: number;
  teacherShare: number;
  paymentCount: number;
};

/**
 * The "Whole Management" roll-up's per-branch breakdown (M11): each row is
 * one branch's own `revenueTotals` call — never a query spanning branches
 * (docs/01-data-model.md §4) — so this table is the visible proof that the
 * summed KPI cards above equal exactly the sum of these rows.
 */
export async function BranchRevenueTable({
  rows,
  showProfit,
  locale,
}: {
  rows: BranchRevenueRowData[];
  showProfit: boolean;
  locale: string;
}) {
  const t = await getTranslations("Analytics.byBranch");

  if (rows.length === 0) {
    return <EmptyState compact icon={<ChartNoAxesColumn />} title={t("empty")} description={t("emptyHint")} />;
  }

  return (
    <ul className="flex flex-col gap-3 md:gap-0">
      <li
        aria-hidden
        className="hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex"
      >
        <span className="min-w-0 flex-1">{t("columns.branch")}</span>
        <span className="md:w-28 md:shrink-0">{t("columns.collected")}</span>
        {showProfit ? (
          <>
            <span className="md:w-28 md:shrink-0">{t("columns.centerShare")}</span>
            <span className="md:w-28 md:shrink-0">{t("columns.teacherShare")}</span>
          </>
        ) : null}
        <span className="md:w-24 md:shrink-0">{t("columns.payments")}</span>
      </li>

      {rows.map((row) => (
        <li
          key={row.branchId}
          className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs text-text-muted md:hidden">{t("columns.branch")}</span>
            <span className="truncate text-sm font-medium text-text-primary">{row.branchName}</span>
          </div>
          <div className="flex md:w-28 md:shrink-0 flex-col">
            <span className="text-xs text-text-muted md:hidden">{t("columns.collected")}</span>
            <span className="truncate text-sm tabular-nums text-text-secondary">
              {formatMoney(row.collected, locale)}
            </span>
          </div>
          {showProfit ? (
            <>
              <div className="flex md:w-28 md:shrink-0 flex-col">
                <span className="text-xs text-text-muted md:hidden">{t("columns.centerShare")}</span>
                <span className="truncate text-sm tabular-nums text-text-secondary">
                  {formatMoney(row.centerShare, locale)}
                </span>
              </div>
              <div className="flex md:w-28 md:shrink-0 flex-col">
                <span className="text-xs text-text-muted md:hidden">{t("columns.teacherShare")}</span>
                <span className="truncate text-sm tabular-nums text-text-secondary">
                  {formatMoney(row.teacherShare, locale)}
                </span>
              </div>
            </>
          ) : null}
          <div className="flex md:w-24 md:shrink-0 flex-col">
            <span className="text-xs text-text-muted md:hidden">{t("columns.payments")}</span>
            <span className="truncate text-sm tabular-nums text-text-secondary">
              {formatNumber(row.paymentCount, locale)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
