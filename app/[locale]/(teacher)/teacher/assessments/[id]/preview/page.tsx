import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { assessmentBranches, requireAssessmentSources } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { PageHeader } from "@/components/shared/page-header";
import { AssessmentPreviewBody } from "@/components/teacher/assessments/assessment-preview-body";
import { findInBranches, getTeacherWorkspaceScope } from "@/lib/auth/teacher-scope";
import { drawOrder, toStudentAssessment } from "@/lib/assessments";
import { findTeacherAssessment, sessionZone } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { ROUTES } from "@/lib/routes";

/**
 * The draft as a student would see it (W2, docs/04 §11.34): rendered from the
 * student-facing serializer `toStudentAssessment` — so no correct mark can
 * reach this page — in a freshly drawn order when shuffle is on (W3 draws it
 * once per attempt). The timer shows the duration and does not run. Nothing
 * is recorded: no attempt, no answer.
 */
export default async function PreviewAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
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
  const view = toStudentAssessment(row, row.shuffle ? drawOrder(row) : undefined);

  const t = await getTranslations("TeacherAssessments.preview");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        back={{ href: ROUTES.teacherAssessment(row.id), label: t("back") }}
      />

      <AssessmentPreviewBody view={view} zone={zone} shuffle={row.shuffle} />
    </div>
  );
}
