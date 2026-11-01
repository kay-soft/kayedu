"use client";

import { useTranslations } from "next-intl";

import type { JoinSummary } from "@/lib/join-summary";

/**
 * The body of every join confirmation (U8): what / where / when / cost, and
 * the one line that money is not taken here. Presentational only — the text
 * arrives formatted from `buildJoinSummary`.
 */
export function JoinSummaryList({ summary }: { summary: JoinSummary }) {
  const t = useTranslations("StudentActions.join");

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-3 sm:grid-cols-2">
        <Row label={t("class")}>{summary.classLabel}</Row>
        <Row label={t("branch")}>{summary.branch}</Row>
        <Row label={t("teacher")}>{summary.teacher}</Row>
        <Row label={t("price")}>{summary.price}</Row>
        {summary.when ? (
          <Row label={t("when")} wide>
            <span dir="auto">{summary.when}</span>
          </Row>
        ) : null}
        {summary.schedule && summary.schedule.length > 0 ? (
          <Row label={t("schedule")} wide>
            <ul className="flex flex-col gap-0.5">
              {summary.schedule.map((slot) => (
                <li key={slot}>{slot}</li>
              ))}
            </ul>
          </Row>
        ) : null}
        {summary.period ? (
          <Row label={t("period")} wide>
            {summary.period}
          </Row>
        ) : null}
      </dl>
      <p className="rounded-lg bg-surface-hover p-3 text-sm text-text-secondary">{t("noCharge")}</p>
    </div>
  );
}

function Row({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? "flex flex-col gap-0.5 sm:col-span-2" : "flex flex-col gap-0.5"}>
      <dt className="text-xs font-medium text-text-muted">{label}</dt>
      <dd className="text-sm font-medium text-text-primary">{children}</dd>
    </div>
  );
}
