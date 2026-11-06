import { notFound } from "next/navigation";
import { Check, X } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { elapsedFormatter } from "@/app/[locale]/(teacher)/teacher/assessments/[id]/results/elapsed";
import { assessmentBranches } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ANSWER_OUTCOME_BADGE, RESULT_STATUS_BADGE } from "@/lib/assessment-results";
import { requirePermission } from "@/lib/auth/tenant";
import { firstGranting, getTeacherScope } from "@/lib/auth/teacher-scope";
import { readAttemptResult } from "@/lib/db/assessment-results";
import { prisma } from "@/lib/db/client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * One student's attempt (W4, D-W33; docs/04 §11.35). Submitted: each question in the
 * assessment's order, what they chose, the correct option, the points, and a text
 * badge (never colour alone). In progress: time left and no answers at all; the read
 * does not return them. The same refusals as the results page.
 */
export default async function AttemptResultPage({ params }: { params: Promise<{ id: string; attemptId: string }> }) {
  const scope = await getTeacherScope();
  const ctx = firstGranting(scope, "assessment.manage.own");
  await requirePermission(ctx, "assessment.manage.own");
  const { id, attemptId } = await params;
  const locale = await getLocale();

  const now = new Date();
  const branches = await assessmentBranches(scope.inView);
  const reads = await Promise.all(
    branches.map((branch) => readAttemptResult(prisma, { userId: scope.user.id }, branch.teacher, id, attemptId, now)),
  );
  if (reads.some((read) => !read.ok && read.error === "draft")) {
    return redirect({ href: ROUTES.teacherAssessment(id), locale });
  }
  const hit = reads.find((read) => read.ok);
  if (!hit?.ok) notFound();
  const { attempt } = hit;

  const r = await getTranslations("TeacherAssessments.results");
  const elapsed = await elapsedFormatter();
  const n = (value: number) => formatNumber(value, locale);
  const status = attempt.answers ? "SUBMITTED" : "IN_PROGRESS";

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
    <div className="flex flex-col gap-6">
      <PageHeader
        title={attempt.studentName}
        description={attempt.title}
        back={{ href: ROUTES.teacherAssessmentResults(attempt.assessmentId), label: r("answers.back") }}
        meta={
          <div className="flex flex-wrap gap-2">
            <Badge variant={RESULT_STATUS_BADGE[status]}>{r(`status.${status}`)}</Badge>
            {attempt.left ? <Badge variant="neutral">{r("leftClass")}</Badge> : null}
          </div>
        }
      />

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
    </div>
  );
}
