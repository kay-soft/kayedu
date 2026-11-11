import { notFound } from "next/navigation";
import { Check, TriangleAlert, X } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { privateTeacherNames, studentBranches } from "@/app/[locale]/(student)/student/assessments/scope";
import { StartAttempt } from "@/app/[locale]/(student)/student/assessments/start-attempt";
import { AssessmentTaker } from "@/app/[locale]/(student)/student/assessments/taker";
import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStudentUser } from "@/lib/auth/tenant";
import {
  ONE_SITTING_HEARTBEAT_SECONDS,
  STUDENT_STATE_BADGE,
  readAttemptReveal,
  readStudentAssessment,
} from "@/lib/db/assessment-attempts";
import { prisma } from "@/lib/db/client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone } from "@/lib/scheduling";
import { sessionDisplayName } from "@/lib/session-label";
import { cn } from "@/lib/utils";

/**
 * One exam or homework, for the student (W3a, docs/04 §11.34). The server decides
 * which face it shows: details and Start; the taking screen; the result; and,
 * only once `readAttemptReveal` allows it, the correct answers (rule 11). Found at
 * the branch whose profile can see it, otherwise a 404: a student who is not
 * enrolled, another centre's student, staff and parents all land there.
 *
 * W9 (D-W42 item 4): a linked PERSONAL workspace's assessment reads the same way
 * (the opt-in resolver feeds `studentBranches`), labelled with the workspace's
 * name, the teacher's and "Private class"; its times in the workspace's zone.
 */
export default async function StudentAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireStudentUser();
  const { id } = await params;
  const now = new Date();

  const branches = await studentBranches(session.user.id);
  const reads = await Promise.all(
    branches.map(async (branch) => ({ branch, view: await readStudentAssessment(prisma, branch.student, id, now) })),
  );
  const hit = reads.find((read) => read.view !== null);
  if (!hit?.view) notFound();
  const { view, branch } = hit;

  const t = await getTranslations("StudentAssessments");
  const locale = await getLocale();
  const zone = view.timeZone ?? centreTimeZone(branch.ctx.settings);
  const classLabel = sessionDisplayName(locale, { classGroup: view.classGroup });
  const branchName = branch.ctx.center.name;
  const privateTeacher = branch.ctx.center.kind === "PERSONAL" ? ((await privateTeacherNames([branch])).get(branch.ctx.center.id) ?? null) : null;
  const tPrivate = await getTranslations("WorkspaceStudents.student");
  const closes = view.type === "EXAM" ? view.windowEnd : view.deadline;
  const closesValue = closes ? formatDateTime(closes, locale, zone) : "";
  const windowLabel = t(view.type === "EXAM" ? "windowLabel" : "deadlineLabel");
  const windowValue =
    view.type === "EXAM" && view.windowStart
      ? t("windowLine", { start: formatDateTime(view.windowStart, locale, zone), end: closesValue })
      : closesValue;
  const durationLine = view.durationMinutes === null ? t("noTimer") : t("minutes", { count: view.durationMinutes });

  if (view.taking) {
    return (
      <AssessmentTaker
        title={view.title}
        oneSitting={view.oneSitting}
        timed={view.durationMinutes !== null}
        heartbeatSeconds={ONE_SITTING_HEARTBEAT_SECONDS}
        taking={view.taking}
      />
    );
  }

  const reveal = view.finished ? await readAttemptReveal(prisma, branch.student, view.finished.attemptId, now) : null;
  const revealLater = view.finished?.showCorrectAnswers && view.state === "SUBMITTED";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={view.title}
        description={[classLabel, branchName, ...(privateTeacher !== null ? [privateTeacher] : [])].join(" · ")}
        back={{ href: ROUTES.studentAssessments, label: t("title") }}
        meta={
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">{t(`type.${view.type}`)}</Badge>
            <Badge variant={STUDENT_STATE_BADGE[view.state]}>{t(`state.${view.state}`)}</Badge>
            {privateTeacher !== null ? <Badge variant="neutral">{tPrivate("privateClass")}</Badge> : null}
          </div>
        }
      />
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <Card>
          <CardContent className="flex flex-col gap-3 text-sm">
            {view.instructions ? (
              <p dir="auto" className="whitespace-pre-line break-words text-text-secondary">{view.instructions}</p>
            ) : null}
            <dl className="flex flex-col gap-2">
              <div className="flex justify-between gap-3">
                <dt className="text-text-secondary">{windowLabel}</dt>
                <dd className="text-end font-medium text-text-primary">{windowValue}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-text-secondary">{t("durationLabel")}</dt>
                <dd className="text-end font-medium text-text-primary">{durationLine}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-text-secondary">{t("questionsLabel")}</dt>
                <dd className="font-medium tabular-nums text-text-primary">{formatNumber(view.questionCount, locale)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-text-secondary">{t("pointsLabel")}</dt>
                <dd className="font-medium tabular-nums text-text-primary">{formatNumber(view.totalPoints, locale)}</dd>
              </div>
            </dl>
            {view.oneSitting && !view.finished ? (
              <FormMessage tone="warning">
                <span className="inline-flex items-center gap-2">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {t("start.oneSitting")}
                </span>
              </FormMessage>
            ) : null}
            {view.state === "UPCOMING" ? <FormMessage tone="info">{t("upcomingHint")}</FormMessage> : null}
            {view.state === "MISSED" ? <FormMessage tone="error">{t("missedHint")}</FormMessage> : null}
            {view.canStart ? (
              <StartAttempt
                assessmentId={view.id}
                title={view.title}
                classLabel={classLabel}
                branchName={branchName}
                durationLine={durationLine}
                windowLabel={windowLabel}
                windowValue={windowValue}
                timed={view.durationMinutes !== null}
                oneSitting={view.oneSitting}
              />
            ) : null}
          </CardContent>
        </Card>

        {view.finished ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("result.title")}</CardTitle>
              <CardDescription>{t(`result.by.${view.finished.finalisedBy}`)}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              {view.finished.score ? (
                <p className="text-2xl font-semibold tabular-nums text-text-primary">
                  {t("scoreLine", {
                    score: formatNumber(view.finished.score.score, locale),
                    max: formatNumber(view.finished.score.maxScore, locale),
                    percent: formatNumber(view.finished.score.percentage, locale),
                  })}
                </p>
              ) : (
                <p className="font-medium text-text-primary">{t("result.submitted")}</p>
              )}
              <p className="text-xs text-text-muted">
                {t("result.at", { date: formatDateTime(view.finished.submittedAt, locale, zone) })}
              </p>
              {revealLater ? <FormMessage tone="info">{t("result.revealLater", { date: closesValue })}</FormMessage> : null}
            </CardContent>
          </Card>
        ) : null}

        {reveal ? (
          <ol className="flex flex-col gap-4">
            {reveal.map((question, index) => (
              <li key={question.id}>
                <Card>
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                      <span>{t("questionOf", { n: index + 1, total: reveal.length })}</span>
                      <Badge variant={question.isCorrect ? "success" : "danger"}>
                        {t(question.isCorrect ? "reveal.right" : question.chosenOptionId ? "reveal.wrong" : "reveal.unanswered")}
                      </Badge>
                    </div>
                    <p dir="auto" className="whitespace-pre-line break-words font-medium text-text-primary">{question.text}</p>
                    <ul className="flex flex-col gap-2">
                      {question.options.map((option) => {
                        const correct = option.id === question.correctOptionId;
                        const chosen = option.id === question.chosenOptionId;
                        return (
                          <li
                            key={option.id}
                            className={cn(
                              "flex min-h-11 items-start gap-2 rounded-xl border border-border px-3 py-2 text-sm",
                              correct && "border-success/30 bg-success-bg",
                              chosen && !correct && "border-danger/30 bg-danger-bg",
                            )}
                          >
                            {correct ? <Check className="mt-0.5 size-4 shrink-0 text-success-fg" aria-hidden /> : null}
                            {chosen && !correct ? <X className="mt-0.5 size-4 shrink-0 text-danger-fg" aria-hidden /> : null}
                            <span dir="auto" className="min-w-0 flex-1 break-words text-text-primary">{option.text}</span>
                            {correct ? <span className="shrink-0 text-xs text-success-fg">{t("reveal.correct")}</span> : null}
                            {chosen ? <span className="shrink-0 text-xs text-text-secondary">{t("reveal.yours")}</span> : null}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="text-xs text-text-muted">
                      {t("reveal.points", {
                        awarded: formatNumber(question.pointsAwarded, locale),
                        points: formatNumber(question.points, locale),
                      })}
                    </p>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </div>
  );
}
