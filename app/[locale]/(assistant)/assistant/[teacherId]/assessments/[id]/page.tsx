import { notFound } from "next/navigation";
import { BarChart3 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { assistantAssessmentBranches } from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/scope";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { AssessmentDetailBody } from "@/components/teacher/assessments/assessment-detail-body";
import { Badge } from "@/components/ui/badge";
import { getAssistantScope } from "@/lib/auth/assistant-context";
import { findTeacherAssessment, sessionZone } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { formatDate, formatTimeRange } from "@/lib/format";
import { redirect } from "@/lib/i18n/navigation";
import { assessmentRoutes, type AssessmentSurface } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * One of the teacher's exams or homework, for their assistant (W7b, D-W37 item
 * 3): the teacher's own builder, or the published row read-only with Extend,
 * Unpublish and Delete — the same body as the teacher's page and the same data
 * functions, so every lock, rule and refusal is the teacher's. Opens only with
 * `assessments.manage` at the row's branch (the branch comes from the row, among
 * the branches `assistantCan` grants), within the assistant's window. A Grader
 * (review only) is sent to a published row's results; a draft is a 404 for them
 * (D-W01).
 */
export default async function AssistantAssessmentPage({ params }: { params: Promise<{ teacherId: string; id: string }> }) {
  const { teacherId, id } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const surface: AssessmentSurface = { kind: "assistant", teacherId };
  const routes = assessmentRoutes(surface);
  const locale = await getLocale();

  const managing = await assistantAssessmentBranches(scope, "assessments.manage");
  let hit: { entry: (typeof managing)[number]; row: NonNullable<Awaited<ReturnType<typeof findTeacherAssessment>>> } | null = null;
  for (const entry of managing) {
    const row = await findTeacherAssessment(prisma, entry.teacher, id, { history: entry.history });
    if (row) {
      hit = { entry, row };
      break;
    }
  }
  if (!hit) {
    // Review only: a published row opens its results; anything else is not found.
    for (const entry of await assistantAssessmentBranches(scope, "assessments.review")) {
      const row = await findTeacherAssessment(prisma, entry.teacher, id, { history: entry.history });
      if (row?.status === "PUBLISHED") return redirect({ href: routes.results(row.id), locale });
    }
    notFound();
  }
  const { entry, row } = hit!;
  const zone = row.session ? sessionZone(row.session, entry.zone) : entry.zone;

  const t = await getTranslations("TeacherAssessments");
  const label = sessionDisplayName(locale, { classGroup: row.classGroup });
  const sessionLine = row.session
    ? `${formatDate(row.session.date, locale)} · ${formatTimeRange(row.session.startTime, row.session.endTime, locale)}`
    : null;
  const published = row.status === "PUBLISHED";
  const title = published
    ? t(row.type === "EXAM" ? "builder.viewExamTitle" : "builder.viewHomeworkTitle")
    : t(row.type === "EXAM" ? "builder.editExamTitle" : "builder.editHomeworkTitle");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        description={[label, sessionLine, scope.branches.length > 1 || entry.isPrivate ? entry.branch.centerName : null].filter(Boolean).join(" · ")}
        back={{ href: routes.list, label: t("builder.back") }}
        action={
          published ? (
            <LinkButton href={routes.results(row.id)}>
              <BarChart3 className="size-4" aria-hidden />
              {t("results.action")}
            </LinkButton>
          ) : undefined
        }
        meta={
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">{t(`type.${row.type}`)}</Badge>
            <Badge variant={published ? "info" : "neutral"}>{t(`status.${row.status}`)}</Badge>
            {entry.isPrivate ? <Badge variant="neutral">{t("privateTag")}</Badge> : null}
          </div>
        }
      />
      <AssessmentDetailBody
        row={row}
        zone={zone}
        centerId={entry.branch.centerId}
        surface={surface}
        readOnly={entry.readOnly ? t(`errors.${entry.readOnly}`) : null}
      />
    </div>
  );
}
