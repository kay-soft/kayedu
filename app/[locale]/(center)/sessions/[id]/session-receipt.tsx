import { getTranslations } from "next-intl/server";

import { formatMoney, formatNumber } from "@/lib/format";
import type { SessionReceiptTotals } from "@/lib/db/payments";

/**
 * Session receipt (docs/04-design-system.md §5 "Receipt / money summary"):
 * bordered panel, right-aligned figures, label→value rows, with attendance
 * counts alongside. Center/teacher profit is only shown to a role permitted
 * `center.profit.view` (spec §7 acceptance criterion 9 — a receptionist
 * denied profit) — `showProfit` decides that, resolved server-side.
 */
export async function SessionReceipt({
  totals,
  showProfit,
  locale,
}: {
  totals: SessionReceiptTotals;
  showProfit: boolean;
  locale: string;
}) {
  const t = await getTranslations("Sessions.receipt");

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
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="font-medium tabular-nums text-text-primary">{value}</dd>
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
