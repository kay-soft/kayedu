import { BriefcaseBusiness, Building2, CalendarCheck, Coins, Undo2 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { DateFilter } from "@/components/shared/date-filter";
import { EmptyState } from "@/components/shared/empty-state";
import { FilterBar } from "@/components/shared/filter-bar";
import { FormMessage } from "@/components/shared/form-message";
import { PageSection } from "@/components/shared/page-section";
import { ResultsRegion } from "@/components/shared/results-region";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EarningsSummary, SourceEarnings } from "@/lib/db/teacher-earnings";
import { formatDate, formatDayRange, formatMoney, formatNumber } from "@/lib/format";
import { EARNINGS_PRESETS, earningsFilterValue, type EarningsPeriodChoice } from "@/lib/validation/earnings";

/**
 * The Earnings page's body (W8d — D-W29, D-W41; docs/04 §11.38), shared by
 * the teacher's page and the assistant's (Full only). Server-rendered from
 * already-scoped per-source results (`lib/db/teacher-earnings.ts`): it sums
 * nothing itself beyond what `summarizeEarnings` did, and it names sources
 * and classes only — never a student (item 7).
 *
 * - **One filter row**: the shared date filter (§11.7) with the page's own
 *   presets — last 7, 30 and 90 days, this month — and its calendar range.
 * - **The window note** when any source's floor cut the period (item 5).
 * - **Collected** is the one figure across branches and workspaces, and it
 *   says so; refunds are their own line (item 2); paid sessions and present /
 *   late / absent counts.
 * - **Branches**: per branch, your share, refunds, collected after refunds,
 *   and — for the teacher — paid out and not yet paid out (item 3).
 *   **Workspaces**: collected only, tagged Private; never in "not yet paid out".
 * - **By class** inside each source, stacked rows at every width (§6: no
 *   horizontal scroll), and **one small trend**: a list by week.
 */
export async function EarningsView({
  audience,
  choice,
  invalid,
  todayIso,
  resetHref,
  sources,
  summary,
  classLabels,
}: {
  audience: "teacher" | "assistant";
  choice: EarningsPeriodChoice;
  invalid: boolean;
  todayIso: string;
  resetHref: string;
  sources: SourceEarnings[];
  summary: EarningsSummary;
  /** `${centerId}:${classGroupId}` → the class's name at that source. */
  classLabels: Record<string, string>;
}) {
  const [t, locale] = await Promise.all([getTranslations("Earnings"), getLocale()]);
  const money = (value: number) => formatMoney(value, locale);
  const count = (value: number) => formatNumber(value, locale);
  const branches = sources.filter((entry) => entry.source.kind === "BRANCH");
  const workspaces = sources.filter((entry) => entry.source.kind === "WORKSPACE");
  const presets = EARNINGS_PRESETS.map((kind) => ({ kind, label: t(`presets.${kind}`) }));
  const periodRanges = sources.map((entry) => entry.range).filter((range): range is { start: Date; end: Date } => range !== null);
  const periodStart = periodRanges.length > 0 ? new Date(Math.min(...periodRanges.map((range) => range.start.getTime()))) : null;
  const periodEnd = periodRanges.length > 0 ? new Date(Math.max(...periodRanges.map((range) => range.end.getTime()))) : null;

  const classLine = (entry: SourceEarnings) =>
    entry.classes.length === 0 ? (
      <p className="text-sm text-text-muted">{t("classes.empty")}</p>
    ) : (
      <ul className="flex flex-col gap-2">
        {entry.classes.map((line) => {
          const label =
            line.classGroupId === null
              ? t("classes.oneOff")
              : (classLabels[`${entry.source.centerId}:${line.classGroupId}`] ?? t("classes.unnamed"));
          return (
            <li
              key={line.classGroupId ?? "one-off"}
              className="flex flex-col gap-1 rounded-lg border border-border-subtle px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-text-primary">{label}</p>
                <p className="text-xs text-text-secondary">
                  {t("classes.line", {
                    paid: count(line.paidSessions),
                    present: count(line.attendance.present),
                    late: count(line.attendance.late),
                    absent: count(line.attendance.absent),
                  })}
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-0.5 text-sm tabular-nums sm:items-end">
                <span className="font-medium text-text-primary">{money(line.net)}</span>
                {line.refunds > 0 ? (
                  <span className="text-xs text-text-secondary">{t("classes.refunded", { amount: money(line.refunds) })}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    );

  const moneyRow = (label: string, value: number, tone?: "muted") => (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={tone === "muted" ? "text-sm text-text-secondary" : "text-sm text-text-primary"}>{label}</dt>
      <dd className="shrink-0 text-sm font-medium tabular-nums text-text-primary">{money(value)}</dd>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent>
          <FilterBar>
            <DateFilter value={earningsFilterValue(choice)} todayIso={todayIso} resetHref={resetHref} presets={presets} />
          </FilterBar>
        </CardContent>
      </Card>

      <ResultsRegion className="flex flex-col gap-6">
        {invalid ? <FormMessage tone="warning">{t("invalidPeriod")}</FormMessage> : null}
        {summary.clampedFrom ? (
          <FormMessage tone="info">
            {t(audience === "teacher" ? "clampedTeacher" : "clampedAssistant", { date: formatDate(summary.clampedFrom, locale) })}
          </FormMessage>
        ) : null}
        {periodStart && periodEnd ? (
          <p className="text-sm text-text-secondary">{t("periodLine", { range: formatDayRange(periodStart, periodEnd, locale) })}</p>
        ) : null}

        {sources.length === 0 ? (
          <Card>
            <CardContent>
              <EmptyState
                icon={<Coins />}
                title={t("noSources")}
                description={t(audience === "teacher" ? "noSourcesTeacher" : "noSourcesAssistant")}
              />
            </CardContent>
          </Card>
        ) : (
          <>
            <StatGrid count={3}>
              <StatCard
                label={t("stats.collected")}
                value={money(summary.collected)}
                hint={t("stats.collectedHint")}
                icon={<Coins className="size-4" />}
                zero={summary.collected === 0}
                zeroLabel={t("stats.zero")}
              />
              <StatCard
                label={t("stats.refunded")}
                value={money(summary.branches.refunds + summary.workspaces.refunds)}
                hint={t("stats.refundedHint")}
                icon={<Undo2 className="size-4" />}
              />
              <StatCard
                label={t("stats.paidSessions")}
                value={count(summary.paidSessions)}
                icon={<CalendarCheck className="size-4" />}
              />
            </StatGrid>
            <StatGrid count={3} dense>
              <StatCard compact label={t("stats.present")} value={count(summary.attendance.present)} />
              <StatCard compact label={t("stats.late")} value={count(summary.attendance.late)} />
              <StatCard compact label={t("stats.absent")} value={count(summary.attendance.absent)} />
            </StatGrid>

            {branches.length > 0 ? (
              <PageSection title={t("branches.title")} description={t("branches.description")}>
                {summary.branches.paidOut !== null && summary.branches.notPaidOut !== null ? (
                  <Card>
                    <CardContent>
                      <dl className="flex flex-col gap-2">
                        {moneyRow(t("branches.teacherShare"), summary.branches.teacherShare)}
                        {moneyRow(t("branches.refunds"), summary.branches.refunds, "muted")}
                        {moneyRow(t("branches.net"), summary.branches.net)}
                        {moneyRow(t("branches.paidOut"), summary.branches.paidOut)}
                        {moneyRow(t("branches.notPaidOut"), summary.branches.notPaidOut)}
                      </dl>
                      <p className="mt-3 text-xs text-text-muted">{t("branches.paidOutHint")}</p>
                    </CardContent>
                  </Card>
                ) : null}
                <div className="grid gap-4 lg:grid-cols-2">
                  {branches.map((entry) => (
                    <Card key={entry.source.centerId}>
                      <CardHeader>
                        <CardTitle as="h3" className="flex min-w-0 items-center gap-2">
                          <Building2 className="size-4 shrink-0 text-text-muted" aria-hidden />
                          <span className="min-w-0 truncate">{entry.source.name}</span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-4">
                        <dl className="flex flex-col gap-2">
                          {moneyRow(t("branches.teacherShare"), entry.teacherShare)}
                          {moneyRow(t("branches.refunds"), entry.refunds, "muted")}
                          {moneyRow(t("branches.net"), entry.net)}
                          {entry.settlement ? moneyRow(t("branches.paidOut"), entry.settlement.paidOut) : null}
                          {entry.settlement ? moneyRow(t("branches.notPaidOut"), entry.settlement.notPaidOut) : null}
                        </dl>
                        <div className="flex flex-col gap-2">
                          <h4 className="text-xs font-medium text-text-secondary">{t("classes.title")}</h4>
                          {classLine(entry)}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </PageSection>
            ) : null}

            {workspaces.length > 0 ? (
              <PageSection title={t("workspaces.title")} description={t("workspaces.description")}>
                <div className="grid gap-4 lg:grid-cols-2">
                  {workspaces.map((entry) => (
                    <Card key={entry.source.centerId}>
                      <CardHeader>
                        <CardTitle as="h3" className="flex min-w-0 flex-wrap items-center gap-2">
                          <BriefcaseBusiness className="size-4 shrink-0 text-text-muted" aria-hidden />
                          <span className="min-w-0 truncate">{entry.source.name}</span>
                          <Badge variant="neutral">{t("workspaces.private")}</Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-4">
                        <dl className="flex flex-col gap-2">
                          {moneyRow(t("workspaces.teacherShare"), entry.teacherShare)}
                          {moneyRow(t("branches.refunds"), entry.refunds, "muted")}
                          {moneyRow(t("workspaces.net"), entry.net)}
                        </dl>
                        <p className="text-xs text-text-muted">{t("workspaces.collectedOnly")}</p>
                        <div className="flex flex-col gap-2">
                          <h4 className="text-xs font-medium text-text-secondary">{t("classes.title")}</h4>
                          {classLine(entry)}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </PageSection>
            ) : null}

            <PageSection title={t("trend.title")} description={t("trend.description")}>
              <Card>
                <CardContent>
                  {summary.trend.length === 0 ? (
                    <p className="text-sm text-text-muted">{t("trend.empty")}</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-border-subtle">
                      {summary.trend.map((row) => (
                        <li key={row.weekStart} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                          <span className="text-sm text-text-primary">
                            {t("trend.week", { date: formatDate(new Date(`${row.weekStart}T00:00:00.000Z`), locale) })}
                          </span>
                          <span className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm tabular-nums">
                            <span className="font-medium text-text-primary">{t("trend.collected", { amount: money(row.teacherShare) })}</span>
                            {row.refunds > 0 ? (
                              <span className="text-text-secondary">{t("trend.refunded", { amount: money(row.refunds) })}</span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </PageSection>
          </>
        )}
      </ResultsRegion>
    </div>
  );
}
