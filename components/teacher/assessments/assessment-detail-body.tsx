import { Check, Eye } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { AssessmentBuilder } from "@/app/[locale]/(teacher)/teacher/assessments/builder";
import { DeleteAssessment } from "@/app/[locale]/(teacher)/teacher/assessments/delete-assessment";
import { payloadFromRow } from "@/app/[locale]/(teacher)/teacher/assessments/initial";
import {
  ExtendAssessment,
  PublishAssessment,
  UnpublishAssessment,
} from "@/app/[locale]/(teacher)/teacher/assessments/publish-controls";
import { LinkButton } from "@/components/shared/link-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { assessmentClosesAt, hasClosed, isReady, readiness, totalPoints } from "@/lib/assessments";
import type { TeacherAssessment } from "@/lib/db/assessments";
import { formatDateTime, formatNumber } from "@/lib/format";
import { assessmentRoutes, type AssessmentSurface } from "@/lib/routes";
import { dateKey, todayInTimezone } from "@/lib/scheduling";
import { fieldsFromInstant } from "@/lib/validation/assessments";

/**
 * One exam or homework's body under its page header (W2, W3a; docs/04 §11.33),
 * shared by the teacher's page and the assistant's (W7b, D-W37): a draft in the
 * builder with Publish and Delete beneath it; a published row read-only with its
 * questions, Extend, Preview, and Unpublish and Delete while nobody has started.
 * `surface` picks the links and the actions; the page found the row first.
 */
export async function AssessmentDetailBody({
  row,
  zone,
  centerId,
  surface,
}: {
  row: TeacherAssessment;
  /** The session's frozen timezone, else the branch's. */
  zone: string;
  /** The row's branch, posted for the teacher's actions (re-resolved there); an assistant's ignore it. */
  centerId: string;
  surface: AssessmentSurface;
}) {
  const t = await getTranslations("TeacherAssessments");
  const locale = await getLocale();
  const now = new Date();
  const routes = assessmentRoutes(surface);
  const published = row.status === "PUBLISHED";
  const attempts = row._count.attempts;
  const closes = assessmentClosesAt(row);

  return (
    <>
      {published ? (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle dir="auto" className="break-words">{row.title}</CardTitle>
                <CardDescription>{t("published.lockedHint")}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {row.instructions ? (
                  <p dir="auto" className="whitespace-pre-line break-words text-text-secondary">{row.instructions}</p>
                ) : null}
                <dl className="flex flex-col gap-2">
                  {row.windowStart ? (
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-secondary">{t("preview.opens")}</dt>
                      <dd className="text-end font-medium text-text-primary">{formatDateTime(row.windowStart, locale, zone)}</dd>
                    </div>
                  ) : null}
                  {closes ? (
                    <div className="flex justify-between gap-3">
                      <dt className="text-text-secondary">{row.type === "EXAM" ? t("preview.closes") : t("preview.due")}</dt>
                      <dd className="text-end font-medium text-text-primary">{formatDateTime(closes, locale, zone)}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-3">
                    <dt className="text-text-secondary">{t("preview.timer")}</dt>
                    <dd className="text-end font-medium text-text-primary">
                      {row.durationMinutes === null ? t("preview.untimed") : t("published.minutes", { count: row.durationMinutes })}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-text-secondary">{t("preview.points")}</dt>
                    <dd className="font-medium tabular-nums text-text-primary">{formatNumber(totalPoints(row.questions), locale)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-text-secondary">{t("published.started")}</dt>
                    <dd className="font-medium tabular-nums text-text-primary">{formatNumber(attempts, locale)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <ol className="flex flex-col gap-4">
              {row.questions.map((question, index) => (
                <li key={question.id}>
                  <Card>
                    <CardContent className="flex flex-col gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                        <span>{t("builder.questionNumber", { n: index + 1 })}</span>
                        <span>{t("preview.pointsLabel", { count: question.points })}</span>
                      </div>
                      <p dir="auto" className="whitespace-pre-line break-words font-medium text-text-primary">{question.text}</p>
                      <ul className="flex flex-col gap-2">
                        {question.options.map((option) => (
                          <li key={option.id} className="flex items-start gap-2 text-sm">
                            {option.isCorrect ? (
                              <Check className="mt-0.5 size-4 shrink-0 text-success-fg" aria-hidden />
                            ) : (
                              <span className="size-4 shrink-0" aria-hidden />
                            )}
                            <span dir="auto" className="min-w-0 break-words text-text-primary">{option.text}</span>
                            {option.isCorrect ? <span className="shrink-0 text-xs text-success-fg">{t("builder.correct")}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ol>
          </div>

          <aside className="flex min-w-0 flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>{t("extend.sectionTitle")}</CardTitle>
                <CardDescription>
                  {hasClosed(row, now) ? t("extend.passedHint") : t("extend.sectionHint")}
                </CardDescription>
              </CardHeader>
              {hasClosed(row, now) ? null : (
                <CardContent>
                  <ExtendAssessment
                    surface={surface}
                    centerId={centerId}
                    assessmentId={row.id}
                    zone={zone}
                    todayIso={dateKey(todayInTimezone(zone, now))}
                    current={fieldsFromInstant(closes, zone)}
                  />
                </CardContent>
              )}
            </Card>
            <LinkButton href={routes.preview(row.id)} className="self-start">
              <Eye className="size-4" aria-hidden />
              {t("builder.preview")}
            </LinkButton>
            {attempts === 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>{t("published.manageTitle")}</CardTitle>
                  <CardDescription>{t("published.manageHint")}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <UnpublishAssessment centerId={centerId} assessmentId={row.id} surface={surface} />
                  <DeleteAssessment centerId={centerId} assessmentId={row.id} published surface={surface} />
                </CardContent>
              </Card>
            ) : null}
          </aside>
        </div>
      ) : (
        <>
          <AssessmentBuilder
            mode="edit"
            centerId={centerId}
            assessmentId={row.id}
            type={row.type}
            zone={zone}
            nowMs={now.getTime()}
            todayIso={dateKey(todayInTimezone(zone, now))}
            initial={payloadFromRow(row, zone)}
            surface={surface}
          />
          <Card>
            <CardHeader>
              <CardTitle>{t("publish.sectionTitle")}</CardTitle>
              <CardDescription>{t("publish.sectionHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <PublishAssessment centerId={centerId} assessmentId={row.id} ready={isReady(readiness(row.type, row, now))} surface={surface} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("builder.delete.sectionTitle")}</CardTitle>
              <CardDescription>{t("builder.delete.sectionHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <DeleteAssessment centerId={centerId} assessmentId={row.id} surface={surface} />
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
