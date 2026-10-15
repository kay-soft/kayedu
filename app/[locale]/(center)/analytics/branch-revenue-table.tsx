import { getTranslations } from "next-intl/server";
import { ChartNoAxesColumn } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { RevenueBreakdown } from "@/app/[locale]/(center)/analytics/revenue-breakdown";

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
    <RevenueBreakdown
      rows={rows.map((row) => ({
        id: row.branchId,
        name: row.branchName,
        collected: row.collected,
        centerShare: row.centerShare,
        teacherShare: row.teacherShare,
        paymentCount: row.paymentCount,
      }))}
      showProfit={showProfit}
      locale={locale}
      labels={{
        name: t("columns.branch"),
        collected: t("columns.collected"),
        centerShare: t("columns.centerShare"),
        teacherShare: t("columns.teacherShare"),
        payments: t("columns.payments"),
      }}
    />
  );
}
