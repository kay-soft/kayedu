import { notFound } from "next/navigation";
import { BarChart3 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { assessmentBranches, assessmentReadOnlyReason, requireAssessmentSources } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { AssessmentDetailBody } from "@/components/teacher/assessments/assessment-detail-body";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { findInBranches, getTeacherWorkspaceScope } from "@/lib/auth/teacher-scope";
import { findTeacherAssessment, sessionZone } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { formatDate, formatTimeRange } from "@/lib/format";
import { ROUTES, TEACHER_SURFACE } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * One exam or homework (W2, W3a; docs/04 §11.33). A draft opens in the builder
 * with Publish beneath it. A published row opens read-only (D-W08): its details
 * and questions, Extend, and Unpublish and Delete while no student has started.
 * Found at the branch that holds it among those where the teacher may manage
 * assessments, and only when the teacher's own membership owns it — another
 * teacher's, or another branch's, is a 404, and so is a published one older than
 * the teacher's own history window (D-W33).
 *
 * W9 (D-W42 items 1, 5, 7): a row in one of the teacher's PERSONAL workspaces
 * opens the same way, named and tagged Private; while the owner is not premium,
 * or the workspace is archived, it reads read-only with the reason.
 */
export default async function EditAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  // W9 (D-W42 item 7): a workspace-only teacher reaches it too; the gate is below.
  const scope = await getTeacherWorkspaceScope();
  const { id } = await params;

  const branches = await assessmentBranches(scope.inView);
  await requireAssessmentSources(scope, branches);
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
  const label = sessionDisplayName(locale, { classGroup: row.classGroup });
  const sessionLine = row.session
    ? `${formatDate(row.session.date, locale)} · ${formatTimeRange(row.session.startTime, row.session.endTime, locale)}`
    : null;
  const published = row.status === "PUBLISHED";
  const isPrivate = branch.ctx.center.kind === "PERSONAL";
  const readOnlyReason = assessmentReadOnlyReason(branch);
  const title = published
    ? t(row.type === "EXAM" ? "builder.viewExamTitle" : "builder.viewHomeworkTitle")
    : t(row.type === "EXAM" ? "builder.editExamTitle" : "builder.editHomeworkTitle");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={title}
        description={[label, sessionLine, scope.inView.length > 1 || isPrivate ? branch.ctx.center.name : null].filter(Boolean).join(" · ")}
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
            {isPrivate ? <Badge variant="neutral">{t("privateTag")}</Badge> : null}
          </div>
        }
      />

      <AssessmentDetailBody
        row={row}
        zone={zone}
        centerId={branch.ctx.center.id}
        surface={TEACHER_SURFACE}
        readOnly={readOnlyReason ? t(`errors.${readOnlyReason}`) : null}
      />
    </div>
  );
}
