import type { AssessmentBranch } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import type { AssistantPermission } from "@/lib/assistant-catalog";
import { scopeBranches, type AssistantBranch, type AssistantScope } from "@/lib/auth/assistant-context";
import { resolveAssessmentTeacher } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";

export type AssistantAssessmentBranch = AssessmentBranch & { branch: AssistantBranch };

/**
 * The teacher's branches where the assistant may work on assessments with
 * `permission` (W7b, D-W37 item 3): `assistantCan` at each (the grant, the
 * teacher's own `assessment.manage.own` cell, the branch setting), then the
 * owning-teacher handle from **the teacher's** context there
 * (`resolveAssessmentTeacher`, the W2 resolver, unchanged). Every list and page
 * read takes the assistant's floor — the stricter of the branch's teacher
 * window and the teacher's own `teacherHistoryDays` (D-W19).
 */
export async function assistantAssessmentBranches(
  scope: AssistantScope,
  permission: Extract<AssistantPermission, "assessments.review" | "assessments.manage">,
): Promise<AssistantAssessmentBranch[]> {
  const resolved = await Promise.all(
    scopeBranches(scope, permission).map(async (branch) => ({
      branch,
      ctx: branch.ctx,
      teacher: await resolveAssessmentTeacher(prisma, branch.ctx),
      zone: branch.zone,
      history: { floor: branch.floor as Date | null, zone: branch.zone },
    })),
  );
  return resolved.flatMap(({ teacher, ...rest }) => (teacher ? [{ ...rest, teacher }] : []));
}
