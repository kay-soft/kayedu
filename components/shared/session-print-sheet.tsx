import { getTranslations } from "next-intl/server";

import type { SessionReceiptView } from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { SessionReceipt } from "@/app/[locale]/(center)/sessions/[id]/session-receipt";
import { DetailRow } from "@/components/shared/field";
import { Ltr } from "@/components/shared/ltr";
import { formatDate, formatNumber, formatTimeRange } from "@/lib/format";
import { todayInTimezone } from "@/lib/scheduling";

export type PrintRosterRow = {
  id: string;
  name: string;
  studentCode: string;
  status: "PRESENT" | "LATE" | "ABSENT";
};

/**
 * The printable A4 session sheet — header, session context, the receipt and
 * the roster. One layout for both print routes: a teacher printing their own
 * session (`/teacher/sessions/[id]/print`, M7) and centre staff printing a
 * closed session's receipt (`/sessions/[id]/print`, R2). The receipt block is
 * the on-screen `SessionReceipt` itself, fed by `loadSessionReceiptView` —
 * the totals, the close and the "Changes during session" section print
 * exactly as they render, never through a second implementation.
 */
export async function SessionPrintSheet({
  centerName,
  className,
  session,
  contextRows,
  receipt,
  showProfit,
  roster,
  locale,
  timeZone,
}: {
  centerName: string;
  className: string;
  session: { date: Date; startTime: string; endTime: string };
  contextRows: { label: string; value: string }[];
  receipt: SessionReceiptView;
  showProfit: boolean;
  roster: PrintRosterRow[];
  locale: string;
  timeZone: string;
}) {
  const t = await getTranslations("SessionPrint");
  const tAttendance = await getTranslations("Sessions.attendance");
  // Sorted here, not by each route, so the teacher's sheet and the staff
  // sheet print the same order (the teacher's had been unsorted).
  const rows = [...roster].sort((a, b) => a.name.localeCompare(b.name, locale));

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-8 print:max-w-none print:p-0">
      <header className="flex flex-col gap-2 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs text-text-secondary">{centerName}</p>
          <h2 className="text-xl font-bold text-text-primary">{className}</h2>
          <p className="mt-1 text-sm text-text-secondary">
            {formatDate(session.date, locale)} ·{" "}
            {formatTimeRange(session.startTime, session.endTime, locale)}
          </p>
        </div>
        <p className="text-xs text-text-secondary">
          {t("printedOn", { date: formatDate(todayInTimezone(timeZone), locale) })}
        </p>
      </header>

      <section className="mt-6">
        <h3 className="text-sm font-semibold text-text-primary">{t("sessionTitle")}</h3>
        <div className="mt-2">
          {contextRows.map((row) => (
            <DetailRow key={row.label} label={row.label} value={row.value} />
          ))}
        </div>
      </section>

      {/* The receipt may run onto a second page: refusing to break had pushed
          a long one whole to the next sheet and left the first half empty.
          Its rows and cards still never split (globals.css, print). */}
      <section className="mt-6">
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{t("receiptTitle")}</h3>
        <SessionReceipt
          totals={receipt.totals}
          showProfit={showProfit}
          locale={locale}
          timeZone={timeZone}
          closure={receipt.closure}
          changes={receipt.changes}
          voids={receipt.voids}
          refunds={receipt.refunds}
          unpaid={receipt.unpaid}
        />
      </section>

      <section className="mt-6">
        <h3 className="text-sm font-semibold text-text-primary">{t("rosterTitle")}</h3>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">{t("rosterEmpty")}</p>
        ) : (
          // A real table: a header row that repeats on every printed page,
          // and columns that line up down the sheet (DES, docs/04 §14.10).
          <table className="mt-2 w-full border-collapse text-sm">
            <thead className="table-header-group">
              <tr className="border-b border-border text-xs text-text-secondary">
                <th scope="col" className="w-10 py-2 pe-3 text-start font-medium">
                  {t("columns.number")}
                </th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  {t("columns.name")}
                </th>
                <th scope="col" className="py-2 pe-3 text-start font-medium">
                  {t("columns.code")}
                </th>
                <th scope="col" className="py-2 text-start font-medium">
                  {t("columns.status")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.id} className="border-b border-border-subtle last:border-0">
                  <td className="py-2 pe-3 align-top tabular-nums text-text-secondary">
                    {formatNumber(index + 1, locale)}
                  </td>
                  <td className="py-2 pe-3 align-top font-medium text-text-primary">{row.name}</td>
                  <td className="py-2 pe-3 align-top text-text-secondary">
                    <Ltr>{row.studentCode}</Ltr>
                  </td>
                  <td className="py-2 align-top text-text-primary">{tAttendance(row.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
