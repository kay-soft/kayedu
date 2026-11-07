import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { assistantAssessmentBranches } from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/scope";
import { PageHeader } from "@/components/shared/page-header";
import { AssessmentPreviewBody } from "@/components/teacher/assessments/assessment-preview-body";
import { drawOrder, toStudentAssessment } from "@/lib/assessments";
import { getAssistantScope } from "@/lib/auth/assistant-context";
import { findTeacherAssessment, sessionZone } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { assessmentRoutes } from "@/lib/routes";

/**
 * The student's view of one of the teacher's assessments, for their assistant
 * (W7b, D-W37 item 3) — `assessments.manage` only, the teacher's preview
 * unchanged: rendered from the student-facing serializer `toStudentAssessment`,
 * so no correct mark reaches the page. Nothing is recorded.
 */
export default async function AssistantPreviewAssessmentPage({ params }: { params: Promise<{ teacherId: string; id: string }> }) {
  const { teacherId, id } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();

  let found: { row: NonNullable<Awaited<ReturnType<typeof findTeacherAssessment>>>; zone: string } | null = null;
  for (const entry of await assistantAssessmentBranches(scope, "assessments.manage")) {
    const row = await findTeacherAssessment(prisma, entry.teacher, id, { history: entry.history });
    if (row) {
      found = { row, zone: row.session ? sessionZone(row.session, entry.zone) : entry.zone };
      break;
    }
  }
  if (!found) notFound();
  const { row, zone } = found!;
  const view = toStudentAssessment(row, row.shuffle ? drawOrder(row) : undefined);
  const t = await getTranslations("TeacherAssessments.preview");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        back={{ href: assessmentRoutes({ kind: "assistant", teacherId }).detail(row.id), label: t("back") }}
      />
      <AssessmentPreviewBody view={view} zone={zone} shuffle={row.shuffle} />
    </div>
  );
}
