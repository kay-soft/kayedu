import { Check, X } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { elapsedFormatter } from "@/app/[locale]/(teacher)/teacher/assessments/[id]/results/elapsed";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ANSWER_OUTCOME_BADGE } from "@/lib/assessment-results";
import type { AttemptResult } from "@/lib/db/assessment-results";
import { formatDateTime, formatNumber } from "@/lib/format";

/**
 * One student's attempt under its page header (W4, D-W33; docs/04 §11.35),
 * shared by the teacher's page and the assistant's (W7b): the facts, then each
 * question with what they chose and the correct option — or, in progress, the
 * time left and no answers (the read returns none).
 */
export async function AttemptResultBody({ attempt }: { attempt: AttemptResult }) {
  const locale = await getLocale();
  const r = await getTranslations("TeacherAssessments.results");
  const elapsed = await elapsedFormatter();
  const n = (value: number) => formatNumber(value, locale);

  const facts: [string, string][] = attempt.answers
    ? [
        [r("columns.score"), attempt.score !== null && attempt.maxScore !== null ? r("score", { score: n(attempt.score), max: n(attempt.maxScore) }) : r("none")],
        [r("columns.percentage"), attempt.percentage !== null ? r("percent", { value: n(attempt.percentage) }) : r("none")],
        [r("columns.timeTaken"), attempt.timeTakenMs !== null ? elapsed(attempt.timeTakenMs) : r("none")],
        [r("columns.ended"), attempt.finalisedBy ? r(`ended.${attempt.finalisedBy}`) : r("none")],
        [r("columns.startedAt"), formatDateTime(attempt.startedAt, locale, attempt.zone)],
        [r("columns.submittedAt"), attempt.submittedAt ? formatDateTime(attempt.submittedAt, locale, attempt.zone) : r("none")],
      ]
    : [
        [r("answers.timeLeft"), elapsed(attempt.timeLeftMs ?? 0)],
        [r("columns.startedAt"), formatDateTime(attempt.startedAt, locale, attempt.zone)],
      ];

  return (
    <>
      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {facts.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-text-secondary">{label}</dt>
                <dd className="font-medium tabular-nums break-words text-text-primary">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {attempt.answers ? (
        <ol className="flex flex-col gap-4">
          {attempt.answers.map((question, index) => (
            <li key={question.id} data-answer-question={index + 1}>
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-sm">{r("analysis.question", { n: n(index + 1) })}</CardTitle>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs tabular-nums text-text-secondary">
                        {r("answers.points", { awarded: n(question.pointsAwarded), points: n(question.points) })}
                      </span>
                      <Badge variant={ANSWER_OUTCOME_BADGE[question.outcome]}>{r(`answers.outcome.${question.outcome}`)}</Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p dir="auto" className="whitespace-pre-line break-words text-sm font-medium text-text-primary">{question.text}</p>
                  <ul className="flex flex-col gap-2">
                    {question.options.map((option) => {
                      const correct = option.id === question.correctOptionId;
                      const chosen = option.id === question.chosenOptionId;
                      return (
                        <li
                          key={option.id}
                          className={
                            chosen || correct
                              ? "flex min-w-0 items-start gap-2 rounded-lg border border-border-strong p-3 text-sm"
                              : "flex min-w-0 items-start gap-2 rounded-lg border border-border p-3 text-sm"
                          }
                        >
                          {correct ? (
                            <Check className="mt-0.5 size-4 shrink-0 text-success-fg" aria-hidden />
                          ) : chosen ? (
                            <X className="mt-0.5 size-4 shrink-0 text-danger-fg" aria-hidden />
                          ) : (
                            <span className="size-4 shrink-0" aria-hidden />
                          )}
                          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <span dir="auto" className="min-w-0 break-words text-text-primary">{option.text}</span>
                            {chosen || correct ? (
                              <div className="flex flex-wrap gap-1.5">
                                {chosen ? <Badge variant="neutral">{r("answers.chosen")}</Badge> : null}
                                {correct ? <Badge variant="success">{r("answers.correct")}</Badge> : null}
                              </div>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-xl border border-border bg-surface p-4 text-sm text-text-secondary">{r("answers.inProgressHint")}</p>
      )}
    </>
  );
}
