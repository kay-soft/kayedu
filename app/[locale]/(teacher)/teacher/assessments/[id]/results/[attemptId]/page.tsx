import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { assessmentBranches, requireAssessmentSources } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { PageHeader } from "@/components/shared/page-header";
import { AttemptResultBody } from "@/components/teacher/assessments/attempt-result-body";
import { Badge } from "@/components/ui/badge";
import { RESULT_STATUS_BADGE } from "@/lib/assessment-results";
import { getTeacherWorkspaceScope } from "@/lib/auth/teacher-scope";
import { readAttemptResult } from "@/lib/db/assessment-results";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

/**
 * One student's attempt (W4, D-W33; docs/04 §11.35). Submitted: each question in the
 * assessment's order, what they chose, the correct option, the points, and a text
 * badge (never colour alone). In progress: time left and no answers at all; the read
 * does not return them. The same refusals as the results page.
 */
export default async function AttemptResultPage({ params }: { params: Promise<{ id: string; attemptId: string }> }) {
  // W9 (D-W42 item 7): a workspace-only teacher reaches it too; the gate is below.
  const scope = await getTeacherWorkspaceScope();
  const { id, attemptId } = await params;
  const locale = await getLocale();

  const now = new Date();
  const branches = await assessmentBranches(scope.inView);
  await requireAssessmentSources(scope, branches);
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
  const status = attempt.answers ? "SUBMITTED" : "IN_PROGRESS";

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

      <AttemptResultBody attempt={attempt} />
    </div>
  );
}
