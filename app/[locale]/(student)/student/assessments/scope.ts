import type { TenantContext } from "@/lib/auth/tenant";
import { getStudentScheduleContexts } from "@/lib/auth/tenant";
import { resolveAssessmentStudent, type AssessmentStudent } from "@/lib/db/assessment-attempts";
import { prisma } from "@/lib/db/client";
import { workspaceTeacherNames } from "@/lib/db/notifications";

export type StudentBranch = { ctx: TenantContext; student: AssessmentStudent };

/**
 * This person's student profiles, one per branch, re-read at each
 * (`resolveAssessmentStudent`): a union of per-branch reads (U7, rule 1). Staff
 * and parents have none, so every assessment read and action answers nothing.
 *
 * W9 (D-W42 item 4): read through **the opt-in student resolver**
 * (`getStudentScheduleContexts`), so a PERSONAL workspace where this account
 * holds its own linked, active profile is one more "branch" here — told apart
 * by `ctx.center.kind === "PERSONAL"`. An unlinked profile belongs to a
 * placeholder with no login, so it is never this person's. Every student
 * assessment page, action and the page-close route read through this one
 * function, and the W2 serializer stays the only path to the taking page.
 */
export async function studentBranches(userId: string): Promise<StudentBranch[]> {
  const contexts = await getStudentScheduleContexts(userId);
  const resolved = await Promise.all(
    contexts.map(async (ctx) => ({ ctx, student: await resolveAssessmentStudent(prisma, ctx.center.id, userId) })),
  );
  return resolved.filter((entry): entry is StudentBranch => entry.student !== null);
}

/**
 * W9 (D-W42 item 4): the teacher's name for each PERSONAL workspace among
 * `branches` — the owner's own local record there (`workspaceTeacherNames`) —
 * so a workspace assessment is labelled with the workspace's name, the
 * teacher's and "Private class". Branches are absent from the map.
 */
export async function privateTeacherNames(branches: StudentBranch[]): Promise<Map<string, string>> {
  const ids = branches.filter(({ ctx }) => ctx.center.kind === "PERSONAL").map(({ ctx }) => ctx.center.id);
  return ids.length > 0 ? workspaceTeacherNames(prisma, ids) : new Map();
}
