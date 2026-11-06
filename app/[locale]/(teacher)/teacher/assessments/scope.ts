import type { TenantContext } from "@/lib/auth/tenant";
import { resolveAssessmentTeacher, type AssessmentTeacher, type TeacherHistory } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { teacherPortalHistoryFloor } from "@/lib/db/teacher-portal";
import { centreTimeZone } from "@/lib/scheduling";

export type AssessmentBranch = { ctx: TenantContext; teacher: AssessmentTeacher; zone: string; history: TeacherHistory };

/**
 * The branches (of those given) where this teacher may manage assessments —
 * `resolveAssessmentTeacher` at each, a union of per-branch checks (U7). A
 * branch whose Owner switched `assessment.manage.own` off contributes nothing.
 */
export async function assessmentBranches(branches: TenantContext[]): Promise<AssessmentBranch[]> {
  const resolved = await Promise.all(
    branches.map(async (ctx) => {
      const zone = centreTimeZone(ctx.settings);
      return { ctx, teacher: await resolveAssessmentTeacher(prisma, ctx), zone, history: { floor: teacherPortalHistoryFloor(ctx), zone } };
    }),
  );
  return resolved.filter((entry): entry is AssessmentBranch => entry.teacher !== null);
}
