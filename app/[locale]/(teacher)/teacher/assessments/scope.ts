import type { TenantContext } from "@/lib/auth/tenant";
import { resolveAssessmentTeacher, type AssessmentTeacher } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { centreTimeZone } from "@/lib/scheduling";

export type AssessmentBranch = { ctx: TenantContext; teacher: AssessmentTeacher; zone: string };

/**
 * The branches (of those given) where this teacher may manage assessments —
 * `resolveAssessmentTeacher` at each, a union of per-branch checks (U7). A
 * branch whose Owner switched `assessment.manage.own` off contributes nothing.
 */
export async function assessmentBranches(branches: TenantContext[]): Promise<AssessmentBranch[]> {
  const resolved = await Promise.all(
    branches.map(async (ctx) => ({ ctx, teacher: await resolveAssessmentTeacher(prisma, ctx), zone: centreTimeZone(ctx.settings) })),
  );
  return resolved.filter((entry): entry is AssessmentBranch => entry.teacher !== null);
}
