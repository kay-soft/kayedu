import { SearchX, Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { ResultRows } from "@/app/[locale]/(teacher)/teacher/assessments/[id]/results/result-rows";
import { ResultsFilters } from "@/app/[locale]/(teacher)/teacher/assessments/[id]/results/results-filters";
import { EmptyState } from "@/components/shared/empty-state";
import { ResultsRegion } from "@/components/shared/results-region";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ResultRow, ResultSort, ResultStatus } from "@/lib/assessment-results";
import type { AssessmentResults } from "@/lib/db/assessment-results";
import { formatNumber } from "@/lib/format";
import type { AssessmentSurface } from "@/lib/routes";

/**
 * One published assessment's results under its page header (W4, D-W33; docs/04
 * §11.35) — the summary, the students and the per-question analysis — shared by
 * the teacher's page and the assistant's (W7b, D-W37). The page read the results
 * (the authority and the window are the data layer's) and filtered the rows.
 */
export async function AssessmentResultsBody({
  results,
  rows,
  search,
  status,
  sort,
  branchName,
  surface,
}: {
  results: AssessmentResults;
  rows: ResultRow[];
  search: string;
  status: ResultStatus | null;
  sort: ResultSort;
  branchName: string;
  surface: AssessmentSurface;
}) {
  const r = await getTranslations("TeacherAssessments.results");
  const locale = await getLocale();
  const n = (value: number) => formatNumber(value, locale);
  const percent = (value: number | null) => (value === null ? r("none") : r("percent", { value: n(value) }));
  const { summary } = results;

  const counts = (items: [string, number][]) => (
    <StatGrid count={items.length} dense>
      {items.map(([label, value]) => (
        <StatCard key={label} compact label={label} value={n(value)} zero={value === 0} />
      ))}
    </StatGrid>
  );

  return (
    <>
      <section aria-label={r("summaryTitle")} className="flex flex-col gap-3 sm:gap-4" data-results-summary>
        {counts([
          [r("summary.eligible"), summary.eligible],
          [r("summary.started"), summary.started],
          [r("summary.submitted"), summary.submitted],
        ])}
        {counts([
          [r("summary.inProgress"), summary.inProgress],
          [r("summary.notStarted"), summary.notStarted],
          [r("summary.missed"), summary.missed],
        ])}
        {summary.submitted > 0 ? (
          <StatGrid count={3} dense>
            <StatCard compact label={r("summary.average")} value={percent(summary.averagePercentage)} />
            <StatCard compact label={r("summary.highest")} value={percent(summary.highestPercentage)} />
            <StatCard compact label={r("summary.lowest")} value={percent(summary.lowestPercentage)} />
          </StatGrid>
        ) : (
          <p className="rounded-xl border border-border bg-surface p-4 text-sm text-text-secondary">{r("noSubmissions")}</p>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{r("studentsTitle")}</CardTitle>
          <CardDescription>{r("studentsHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ResultsFilters query={search} status={status ?? ""} sort={sort} />
          <ResultsRegion className="flex flex-col gap-4">
            {rows.length > 0 ? (
              <ResultRows rows={rows} assessmentId={results.id} branchName={branchName} zone={results.zone} surface={surface} />
            ) : results.students.length > 0 ? (
              <EmptyState icon={<SearchX />} tone="warning" title={r("emptyFiltered")} />
            ) : (
              <EmptyState icon={<Users />} title={r("empty")} />
            )}
          </ResultsRegion>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{r("analysis.title")}</CardTitle>
          <CardDescription>{r("analysis.hint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {summary.submitted === 0 ? (
            <p className="text-sm text-text-secondary">{r("noSubmissions")}</p>
          ) : (
            <ol className="flex flex-col gap-4">
              {results.questions.map((question, index) => (
                <li key={question.id} data-analysis-question={index + 1} className="flex flex-col gap-3 rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
                    <span>{r("analysis.question", { n: n(index + 1) })}</span>
                    <span className="font-medium tabular-nums text-text-primary">
                      {r("analysis.correctLine", {
                        percent: n(question.correctPercentage ?? 0),
                        correct: n(question.correctCount),
                        submitted: n(summary.submitted),
                      })}
                    </span>
                  </div>
                  <p dir="auto" className="whitespace-pre-line break-words text-sm font-medium text-text-primary">{question.text}</p>
                  <ul className="flex flex-col gap-2">
                    {question.options.map((option) => (
                      <li key={option.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-sm">
                        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                          <span dir="auto" className="min-w-0 break-words text-text-primary">{option.text}</span>
                          {option.isCorrect ? <Badge variant="success">{r("analysis.correctAnswer")}</Badge> : null}
                        </span>
                        <span className="shrink-0 tabular-nums text-text-secondary">{r("analysis.chosenBy", { count: n(option.count) })}</span>
                      </li>
                    ))}
                    <li className="flex justify-between gap-3 text-sm text-text-secondary">
                      <span>{r("analysis.unanswered")}</span>
                      <span className="shrink-0 tabular-nums">{n(question.unanswered)}</span>
                    </li>
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </>
  );
}
