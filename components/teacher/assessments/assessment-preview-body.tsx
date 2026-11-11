import { Clock, TriangleAlert } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/shared/empty-state";
import { FormMessage } from "@/components/shared/form-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { toStudentAssessment } from "@/lib/assessments";
import { formatDateTime, formatNumber, formatTwoDigits } from "@/lib/format";

/**
 * The student's view of a draft, under the preview page's header (W2, docs/04
 * §11.34) — shared by the teacher's preview and the assistant's (W7b). It takes
 * only the **student-facing** serialization (`toStudentAssessment`, made by the
 * page), so no correct mark can reach it. Nothing is recorded.
 */
export async function AssessmentPreviewBody({
  view,
  zone,
  shuffle,
}: {
  view: ReturnType<typeof toStudentAssessment>;
  zone: string;
  shuffle: boolean;
}) {
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
          {shuffle ? <p className="text-xs text-text-muted">{t("shuffled")}</p> : null}
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
  );
}
