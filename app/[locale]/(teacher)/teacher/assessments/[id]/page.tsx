import { notFound } from "next/navigation";
import { BarChart3, Check, Eye } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { AssessmentBuilder } from "@/app/[locale]/(teacher)/teacher/assessments/builder";
import { DeleteAssessment } from "@/app/[locale]/(teacher)/teacher/assessments/delete-assessment";
import { payloadFromRow } from "@/app/[locale]/(teacher)/teacher/assessments/initial";
import {
  ExtendAssessment,
  PublishAssessment,
  UnpublishAssessment,
} from "@/app/[locale]/(teacher)/teacher/assessments/publish-controls";
import { assessmentBranches } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { assessmentClosesAt, hasClosed, isReady, readiness, totalPoints } from "@/lib/assessments";
import { requirePermission } from "@/lib/auth/tenant";
import { findInBranches, firstGranting, getTeacherScope } from "@/lib/auth/teacher-scope";
import { findTeacherAssessment, sessionZone } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { formatDate, formatDateTime, formatNumber, formatTimeRange } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { dateKey, todayInTimezone } from "@/lib/scheduling";
import { sessionDisplayName } from "@/lib/session-label";
import { fieldsFromInstant } from "@/lib/validation/assessments";

/**
 * One exam or homework (W2, W3a; docs/04 §11.33). A draft opens in the builder
 * with Publish beneath it. A published row opens read-only (D-W08): its details
 * and questions, Extend, and Unpublish and Delete while no student has started.
 * Found at the branch that holds it among those where the teacher may manage
 * assessments, and only when the teacher's own membership owns it — another
 * teacher's, or another branch's, is a 404, and so is a published one older than
 * the teacher's own history window (D-W33).
 */
export default async function EditAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const scope = await getTeacherScope();
  const ctx = firstGranting(scope, "assessment.manage.own");
  await requirePermission(ctx, "assessment.manage.own");
  const { id } = await params;

  const branches = await assessmentBranches(scope.inView);
  const hit = await findInBranches(
    branches.map((branch) => branch.ctx),
    (branchCtx) => {
      const found = branches.find((b) => b.ctx === branchCtx)!;
      return findTeacherAssessment(prisma, found.teacher, id, { history: found.history });
    },
  );
  if (!hit) notFound();
  const branch = branches.find((b) => b.ctx === hit!.ctx)!;
  const row = hit!.found;
  const zone = row.session ? sessionZone(row.session, branch.zone) : branch.zone;

  const t = await getTranslations("TeacherAssessments");
  const locale = await getLocale();
  const now = new Date();
  const label = sessionDisplayName(locale, { classGroup: row.classGroup });
  const sessionLine = row.session
    ? `${formatDate(row.session.date, locale)} · ${formatTimeRange(row.session.startTime, row.session.endTime, locale)}`
    : null;
  const centerId = branch.ctx.center.id;
  const published = row.status === "PUBLISHED";
  const attempts = row._count.attempts;
  const closes = assessmentClosesAt(row);
  const title = published
    ? t(row.type === "EXAM" ? "builder.viewExamTitle" : "builder.viewHomeworkTitle")
    : t(row.type === "EXAM" ? "builder.editExamTitle" : "builder.editHomeworkTitle");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        description={[label, sessionLine, scope.inView.length > 1 ? branch.ctx.center.name : null].filter(Boolean).join(" · ")}
        back={{ href: ROUTES.teacherAssessments, label: t("builder.back") }}
        action={
          published ? (
            <LinkButton href={ROUTES.teacherAssessmentResults(row.id)}>
              <BarChart3 className="size-4" aria-hidden />
              {t("results.action")}
            </LinkButton>
          ) : undefined
        }
        meta={
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">{t(`type.${row.type}`)}</Badge>
            <Badge variant={published ? "info" : "neutral"}>{t(`status.${row.status}`)}</Badge>
          </div>
        }
      />

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
                    centerId={centerId}
                    assessmentId={row.id}
                    zone={zone}
                    todayIso={dateKey(todayInTimezone(zone, now))}
                    current={fieldsFromInstant(closes, zone)}
                  />
                </CardContent>
              )}
            </Card>
            <LinkButton href={ROUTES.teacherAssessmentPreview(row.id)} className="self-start">
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
                  <UnpublishAssessment centerId={centerId} assessmentId={row.id} />
                  <DeleteAssessment centerId={centerId} assessmentId={row.id} published />
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
          />
          <Card>
            <CardHeader>
              <CardTitle>{t("publish.sectionTitle")}</CardTitle>
              <CardDescription>{t("publish.sectionHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <PublishAssessment centerId={centerId} assessmentId={row.id} ready={isReady(readiness(row.type, row, now))} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("builder.delete.sectionTitle")}</CardTitle>
              <CardDescription>{t("builder.delete.sectionHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <DeleteAssessment centerId={centerId} assessmentId={row.id} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
