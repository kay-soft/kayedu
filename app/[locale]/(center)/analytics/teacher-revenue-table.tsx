import { getTranslations } from "next-intl/server";
import { ChartNoAxesColumn } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { RevenueBreakdown } from "@/app/[locale]/(center)/analytics/revenue-breakdown";

export type TeacherRevenueRowData = {
  teacherId: string;
  teacherName: string;
  collected: number;
  centerShare: number;
  teacherShare: number;
  paymentCount: number;
};

/**
 * The by-teacher revenue breakdown (spec §4.1 item 5). Only rendered when no
 * single teacher is selected in the filter — narrowing to one teacher already
 * narrows every KPI card above, so a one-row "breakdown" would be redundant.
 * `showProfit` hides center/teacher share exactly like the session receipt
 * (spec §7 acceptance criterion 9 — a receptionist denied profit); in
 * practice this page is OWNER/MANAGER-only anyway (`analytics.center.view`),
 * so `showProfit` is a defense-in-depth mirror of that gate, not the gate
 * itself.
 */
export async function TeacherRevenueTable({
  rows,
  showProfit,
  locale,
}: {
  rows: TeacherRevenueRowData[];
  showProfit: boolean;
  locale: string;
}) {
  const t = await getTranslations("Analytics.byTeacher");

  if (rows.length === 0) {
    return <EmptyState compact icon={<ChartNoAxesColumn />} title={t("empty")} description={t("emptyHint")} />;
  }

  return (
    <RevenueBreakdown
      rows={rows.map((row) => ({
        id: row.teacherId,
        name: row.teacherName,
        collected: row.collected,
        centerShare: row.centerShare,
        teacherShare: row.teacherShare,
        paymentCount: row.paymentCount,
      }))}
      showProfit={showProfit}
      locale={locale}
      labels={{
        name: t("columns.teacher"),
        collected: t("columns.collected"),
        centerShare: t("columns.centerShare"),
        teacherShare: t("columns.teacherShare"),
        payments: t("columns.payments"),
      }}
    />
  );
}
