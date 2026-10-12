import { getTranslations } from "next-intl/server";
import { Ban } from "lucide-react";

import type {
  ReceiptChange,
  ReceiptClosure,
} from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { formatDateTime, formatMoney, formatNumber } from "@/lib/format";
import type { SessionReceiptTotals } from "@/lib/db/payments";

/**
 * Session receipt (docs/04-design-system.md §5 "Receipt / money summary"):
 * bordered panel, right-aligned figures, label→value rows, with attendance
 * counts alongside. Center/teacher profit is only shown to a role permitted
 * `center.profit.view` (spec §7 acceptance criterion 9 — a receptionist
 * denied profit) — `showProfit` decides that, resolved server-side.
 *
 * R2 adds the close (when and how the session closed) and, at the end, a
 * "Changes during session" section listing every live status change from
 * `SessionAttendanceChange` — absent entirely when nothing was changed.
 * Voided payments are already outside every total (`sessionReceiptTotals`).
 * The printed receipt renders the same data (`components/shared/
 * session-print-sheet.tsx`), loaded through the same `loadSessionReceiptView`.
 */
export async function SessionReceipt({
  totals,
  showProfit,
  locale,
  timeZone,
  closure = null,
  changes = [],
  showOpenNote = false,
}: {
  totals: SessionReceiptTotals;
  showProfit: boolean;
  locale: string;
  timeZone: string;
  closure?: ReceiptClosure;
  changes?: ReceiptChange[];
  /** Say plainly that an un-closed session's figures can still change. */
  showOpenNote?: boolean;
}) {
  const t = await getTranslations("Sessions.receipt");
  const tAttendance = await getTranslations("Sessions.attendance");

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <dl className="flex flex-col gap-2 text-sm">
        <Row label={t("collected")} value={formatMoney(totals.collected, locale)} />
        {showProfit ? (
          <>
            <Row label={t("centerShare")} value={formatMoney(totals.centerShare, locale)} />
            <Row label={t("teacherShare")} value={formatMoney(totals.teacherShare, locale)} />
          </>
        ) : null}
      </dl>

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border-subtle pt-4">
        <Count label={t("present")} value={totals.presentCount} tone="success" locale={locale} />
        <Count label={t("late")} value={totals.lateCount} tone="warning" locale={locale} />
        <Count label={t("absent")} value={totals.absentCount} tone="danger" locale={locale} />
      </div>

      {closure ? (
        <dl className="mt-4 border-t border-border-subtle pt-4 text-sm">
          <Row
            label={t("closed")}
            value={
              closure.closeMode === "AUTO"
                ? t("closedAuto", { time: formatDateTime(closure.closedAt, locale, timeZone) })
                : t("closedManual", {
                    time: formatDateTime(closure.closedAt, locale, timeZone),
                    name: closure.closedByName ?? t("unknownActor"),
                  })
            }
          />
        </dl>
      ) : showOpenNote ? (
        <p className="mt-4 border-t border-border-subtle pt-4 text-xs text-text-muted">
          {t("notClosed")}
        </p>
      ) : null}

      {changes.length > 0 ? (
        <section className="mt-4 border-t border-border-subtle pt-4">
          <h3 className="text-sm font-semibold text-text-primary">{t("changesTitle")}</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {changes.map((change) => (
              <li
                key={change.id}
                className="flex flex-col gap-1 rounded-lg bg-surface-subtle px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 font-medium text-text-primary">{change.studentName}</span>
                  <span className="text-text-secondary">
                    {t("changeStatus", {
                      from: tAttendance(change.fromStatus),
                      to: tAttendance(change.toStatus),
                    })}
                  </span>
                </div>
                <p className="text-xs text-text-muted">
                  {t("changeMeta", {
                    time: formatDateTime(change.changedAt, locale, timeZone),
                    name: change.changedByName ?? t("unknownActor"),
                  })}
                </p>
                {change.reason ? (
                  <p className="text-xs text-text-secondary">
                    {t("changeReason", { reason: change.reason })}
                  </p>
                ) : null}
                {change.paymentVoided ? (
                  <span className="inline-flex w-fit items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 text-xs font-medium text-danger">
                    <Ban className="size-3" aria-hidden />
                    {t("paymentVoided")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-end font-medium tabular-nums text-text-primary">{value}</dd>
    </div>
  );
}

const TONE_TEXT = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
} as const;

function Count({
  label,
  value,
  tone,
  locale,
}: {
  label: string;
  value: number;
  tone: keyof typeof TONE_TEXT;
  locale: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg bg-surface-subtle py-2">
      <span className={`text-xl font-bold tabular-nums ${TONE_TEXT[tone]}`}>
        {formatNumber(value, locale)}
      </span>
      <span className="text-xs text-text-muted">{label}</span>
    </div>
  );
}
