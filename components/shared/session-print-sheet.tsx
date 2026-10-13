import { getTranslations } from "next-intl/server";

import type { SessionReceiptView } from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { SessionReceipt } from "@/app/[locale]/(center)/sessions/[id]/session-receipt";
import { DetailRow } from "@/components/shared/field";
import { formatDate, formatTimeRange } from "@/lib/format";
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

  return (
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-8 print:max-w-none print:p-0">
      <header className="flex flex-col gap-2 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs text-text-muted">{centerName}</p>
          <h2 className="text-xl font-bold text-text-primary">{className}</h2>
          <p className="mt-1 text-sm text-text-secondary">
            {formatDate(session.date, locale)} ·{" "}
            {formatTimeRange(session.startTime, session.endTime, locale)}
          </p>
        </div>
        <p className="text-xs text-text-muted">
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

      <section className="mt-6 break-inside-avoid">
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{t("receiptTitle")}</h3>
        <SessionReceipt
          totals={receipt.totals}
          showProfit={showProfit}
          locale={locale}
          timeZone={timeZone}
          closure={receipt.closure}
          changes={receipt.changes}
        />
      </section>

      <section className="mt-6">
        <h3 className="text-sm font-semibold text-text-primary">{t("rosterTitle")}</h3>
        {roster.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">{t("rosterEmpty")}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {roster.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-x-3 border-b border-border-subtle py-2 text-sm last:border-0"
              >
                <span className="font-medium text-text-primary">{row.name}</span>
                <span className="text-text-secondary" dir="ltr">
                  {row.studentCode}
                </span>
                <span className="text-text-secondary">{tAttendance(row.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
