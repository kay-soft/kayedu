import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { assistantAssessmentBranches } from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/scope";
import { PageHeader } from "@/components/shared/page-header";
import { AttemptResultBody } from "@/components/teacher/assessments/attempt-result-body";
import { Badge } from "@/components/ui/badge";
import { RESULT_STATUS_BADGE } from "@/lib/assessment-results";
import { getAssistantScope, scopeBranches } from "@/lib/auth/assistant-context";
import { readAttemptResult } from "@/lib/db/assessment-results";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { assessmentRoutes } from "@/lib/routes";

/**
 * One student's attempt, for the teacher's assistant (W7b, D-W37 item 3) — the
 * W4 read with actor = the assistant, the same refusals and window as the
 * results page. Submitted: the answers; in progress: time left and no answers.
 */
export default async function AssistantAttemptResultPage({
  params,
}: {
  params: Promise<{ teacherId: string; id: string; attemptId: string }>;
}) {
  const { teacherId, id, attemptId } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const locale = await getLocale();
  const routes = assessmentRoutes({ kind: "assistant", teacherId });

  const now = new Date();
  const branches = await assistantAssessmentBranches(scope, "assessments.review");
  const reads = await Promise.all(
    branches.map((entry) => readAttemptResult(prisma, { userId: scope.user.id }, entry.teacher, id, attemptId, now)),
  );
  if (reads.some((read) => !read.ok && read.error === "draft")) {
    // A draft has no results: its builder, for an assistant who may manage it (D-W01).
    if (scopeBranches(scope, "assessments.manage").length === 0) notFound();
    return redirect({ href: routes.detail(id), locale });
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
        back={{ href: routes.results(attempt.assessmentId), label: r("answers.back") }}
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
