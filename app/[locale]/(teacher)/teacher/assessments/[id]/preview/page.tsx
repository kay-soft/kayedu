import { notFound } from "next/navigation";
import { Clock, TriangleAlert } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { assessmentBranches } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { EmptyState } from "@/components/shared/empty-state";
import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/tenant";
import { findInBranches, firstGranting, getTeacherScope } from "@/lib/auth/teacher-scope";
import { drawOrder, toStudentAssessment } from "@/lib/assessments";
import { findTeacherAssessment, sessionZone } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { formatDateTime, formatNumber, formatTwoDigits } from "@/lib/format";
import { ROUTES } from "@/lib/routes";

/**
 * The draft as a student would see it (W2, docs/04 §11.34): rendered from the
 * student-facing serializer `toStudentAssessment` — so no correct mark can
 * reach this page — in a freshly drawn order when shuffle is on (W3 draws it
 * once per attempt). The timer shows the duration and does not run. Nothing
 * is recorded: no attempt, no answer.
 */
export default async function PreviewAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const scope = await getTeacherScope();
  const ctx = firstGranting(scope, "assessment.manage.own");
  await requirePermission(ctx, "assessment.manage.own");
  const { id } = await params;

  const branches = await assessmentBranches(scope.inView);
  const hit = await findInBranches(
    branches.map((branch) => branch.ctx),
    (branchCtx) => findTeacherAssessment(prisma, branches.find((b) => b.ctx === branchCtx)!.teacher, id),
  );
  if (!hit) notFound();
  const branch = branches.find((b) => b.ctx === hit!.ctx)!;
  const row = hit!.found;
  const zone = row.session ? sessionZone(row.session, branch.zone) : branch.zone;
  const view = toStudentAssessment(row, row.shuffle ? drawOrder(row) : undefined);

  const t = await getTranslations("TeacherAssessments.preview");
  const locale = await getLocale();
  const total = view.questions.length;
  const timer =
    view.durationMinutes === null
      ? null
      : view.durationMinutes >= 60
        ? `${formatNumber(Math.floor(view.durationMinutes / 60), locale)}:${formatTwoDigits(view.durationMinutes % 60, locale)}:${formatTwoDigits(0, locale)}`
        : `${formatTwoDigits(view.durationMinutes, locale)}:${formatTwoDigits(0, locale)}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        back={{ href: ROUTES.teacherAssessment(row.id), label: t("back") }}
      />

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle dir="auto" className="break-words">{view.title}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {view.instructions ? (
              <p dir="auto" className="whitespace-pre-line break-words text-text-secondary">{view.instructions}</p>
            ) : null}
            <dl className="flex flex-col gap-2">
              {view.type === "EXAM" ? (
                <>
                  <div className="flex justify-between gap-3">
                    <dt className="text-text-secondary">{t("opens")}</dt>
                    <dd className="text-end font-medium text-text-primary">{view.windowStart ? formatDateTime(view.windowStart, locale, zone) : t("notSet")}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-text-secondary">{t("closes")}</dt>
                    <dd className="text-end font-medium text-text-primary">{view.windowEnd ? formatDateTime(view.windowEnd, locale, zone) : t("notSet")}</dd>
                  </div>
                </>
              ) : (
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">{t("due")}</dt>
                  <dd className="text-end font-medium text-text-primary">{view.deadline ? formatDateTime(view.deadline, locale, zone) : t("notSet")}</dd>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <dt className="text-text-secondary">{t("points")}</dt>
                <dd className="font-medium tabular-nums text-text-primary">{formatNumber(view.totalPoints, locale)}</dd>
              </div>
            </dl>
            <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-text-secondary" role="timer" aria-live="off">
              <Clock className="size-4 shrink-0" aria-hidden />
              <span>{timer ? t("timer") : t("untimed")}</span>
              {timer ? <span dir="ltr" className="font-semibold tabular-nums text-text-primary">{timer}</span> : null}
              {timer ? <span className="text-xs text-text-muted">{t("timerPaused")}</span> : null}
            </div>
            {view.oneSitting ? (
              <FormMessage tone="warning">
                <span className="inline-flex items-center gap-2">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden />
                  {t("oneSittingWarning")}
                </span>
              </FormMessage>
            ) : null}
            {row.shuffle ? <p className="text-xs text-text-muted">{t("shuffled")}</p> : null}
          </CardContent>
        </Card>

        {total === 0 ? (
          <EmptyState title={t("empty")} />
        ) : (
          <ol className="flex flex-col gap-4">
            {view.questions.map((question, index) => (
              <li key={question.id}>
                <Card>
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                      <span>{t("questionOf", { n: index + 1, total })}</span>
                      <span>{t("pointsLabel", { count: question.points })}</span>
                    </div>
                    <p dir="auto" className="whitespace-pre-line break-words text-base font-medium text-text-primary">{question.text}</p>
                    <div role="radiogroup" aria-label={t("questionOf", { n: index + 1, total })} className="flex flex-col gap-2">
                      {question.options.map((option) => (
                        <label
                          key={option.id}
                          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-border px-3 py-2 hover:bg-surface-hover has-[:checked]:border-brand has-[:checked]:bg-brand/5"
                        >
                          <input type="radio" name={`preview-${question.id}`} className="size-5 shrink-0 accent-brand" />
                          <span dir="auto" className="min-w-0 break-words text-sm text-text-primary">{option.text}</span>
                        </label>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        )}

        <div className="flex flex-col gap-1">
          <Button type="button" disabled className="self-start">{t("start")}</Button>
          <p className="text-xs text-text-muted">{t("startDisabled")}</p>
        </div>
      </div>
    </div>
  );
}
