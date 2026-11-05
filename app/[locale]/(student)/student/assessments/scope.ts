import type { TenantContext } from "@/lib/auth/tenant";
import { getStudentContexts } from "@/lib/auth/tenant";
import { resolveAssessmentStudent, type AssessmentStudent } from "@/lib/db/assessment-attempts";
import { prisma } from "@/lib/db/client";

export type StudentBranch = { ctx: TenantContext; student: AssessmentStudent };

/**
 * This person's student profiles, one per branch, re-read at each
 * (`resolveAssessmentStudent`): a union of per-branch reads (U7, rule 1). Staff
 * and parents have none, so every assessment read and action answers nothing.
 */
export async function studentBranches(userId: string): Promise<StudentBranch[]> {
  const contexts = await getStudentContexts(userId);
  const resolved = await Promise.all(
    contexts.map(async (ctx) => ({ ctx, student: await resolveAssessmentStudent(prisma, ctx.center.id, userId) })),
  );
  return resolved.filter((entry): entry is StudentBranch => entry.student !== null);
}
