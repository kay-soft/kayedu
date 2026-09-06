import { getTranslations } from "next-intl/server";

import { formatMoney, formatNumber } from "@/lib/format";

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
    return <p className="text-sm text-text-muted">{t("empty")}</p>;
  }

  return (
    <ul className="flex flex-col gap-3 md:gap-0">
      <li
        aria-hidden
        className="hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex"
      >
        <span className="min-w-0 flex-1">{t("columns.teacher")}</span>
        <span className="w-28 shrink-0">{t("columns.collected")}</span>
        {showProfit ? (
          <>
            <span className="w-28 shrink-0">{t("columns.centerShare")}</span>
            <span className="w-28 shrink-0">{t("columns.teacherShare")}</span>
          </>
        ) : null}
        <span className="w-24 shrink-0">{t("columns.payments")}</span>
      </li>

      {rows.map((row) => (
        <li
          key={row.teacherId}
          className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs text-text-muted md:hidden">{t("columns.teacher")}</span>
            <span className="truncate text-sm font-medium text-text-primary">{row.teacherName}</span>
          </div>
          <div className="flex w-28 shrink-0 flex-col">
            <span className="text-xs text-text-muted md:hidden">{t("columns.collected")}</span>
            <span className="truncate text-sm tabular-nums text-text-secondary">
              {formatMoney(row.collected, locale)}
            </span>
          </div>
          {showProfit ? (
            <>
              <div className="flex w-28 shrink-0 flex-col">
                <span className="text-xs text-text-muted md:hidden">{t("columns.centerShare")}</span>
                <span className="truncate text-sm tabular-nums text-text-secondary">
                  {formatMoney(row.centerShare, locale)}
                </span>
              </div>
              <div className="flex w-28 shrink-0 flex-col">
                <span className="text-xs text-text-muted md:hidden">{t("columns.teacherShare")}</span>
                <span className="truncate text-sm tabular-nums text-text-secondary">
                  {formatMoney(row.teacherShare, locale)}
                </span>
              </div>
            </>
          ) : null}
          <div className="flex w-24 shrink-0 flex-col">
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
