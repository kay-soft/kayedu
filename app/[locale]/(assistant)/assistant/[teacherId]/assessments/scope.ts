import type { AssistantPermission } from "@/lib/assistant-catalog";
import { scopeBranches, scopeWorkspaces, type AssistantScope } from "@/lib/auth/assistant-context";
import type { TenantContext } from "@/lib/auth/tenant";
import { resolveAssessmentTeacher, type AssessmentTeacher, type TeacherHistory } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";

/**
 * One place the assistant may work on the teacher's exams and homework: one of
 * the teacher's branches, or (W9, D-W42 item 9) one of the teacher's PERSONAL
 * workspaces. `branch` names it and carries the assistant's floor there; `ctx`
 * is the **teacher's** context at a branch and null in a workspace (no context
 * is ever built for an assistant there — every read takes the centre id).
 */
export type AssistantAssessmentBranch = {
  teacher: AssessmentTeacher;
  zone: string;
  history: TeacherHistory;
  branch: { centerId: string; centerName: string; floor: Date | null };
  ctx: TenantContext | null;
  isPrivate: boolean;
  /** W9 (D-W42 item 5): an archived workspace takes no write (the writers refuse it too); null elsewhere. */
  readOnly: "workspaceArchived" | null;
};

/**
 * The teacher's places where the assistant may work on assessments with
 * `permission` (W7b, D-W37 item 3): `assistantCan` at each (the grant, the
 * teacher's own `assessment.manage.own` cell, the branch setting), then the
 * owning-teacher handle from **the teacher's** context there
 * (`resolveAssessmentTeacher`, the W2 resolver, unchanged). Every list and page
 * read takes the assistant's floor — the stricter of the branch's teacher
 * window and the teacher's own `teacherHistoryDays` (D-W19).
 *
 * W9 (D-W42 item 9): **plus the teacher's PERSONAL workspaces** where
 * `assistantCan` grants it — there the grant AND the teacher's fixed
 * `workspace.assessments.manage` — built only from the scope's workspaces (the
 * teacher's own, from the teacher's id) and the teacher's ACTIVE TEACHER
 * membership there. The floor in a workspace is the teacher's
 * `teacherHistoryDays` only (D-W19). Every writer re-checks the assistant, the
 * capability, premium and "not archived" inside its own transaction.
 */
export async function assistantAssessmentBranches(
  scope: AssistantScope,
  permission: Extract<AssistantPermission, "assessments.review" | "assessments.manage">,
): Promise<AssistantAssessmentBranch[]> {
  const resolved = await Promise.all(
    scopeBranches(scope, permission).map(async (branch): Promise<AssistantAssessmentBranch | null> => {
      const teacher = await resolveAssessmentTeacher(prisma, branch.ctx);
      return teacher
        ? {
            teacher,
            ctx: branch.ctx,
            zone: branch.zone,
            history: { floor: branch.floor as Date | null, zone: branch.zone },
            branch: { centerId: branch.centerId, centerName: branch.centerName, floor: branch.floor as Date | null },
            isPrivate: false,
            readOnly: null,
          }
        : null;
    }),
  );
  const workspaces = scopeWorkspaces(scope, permission).flatMap((workspace): AssistantAssessmentBranch[] =>
    workspace.teacherMembershipId
      ? [
          {
            teacher: { centerId: workspace.centerId, membershipId: workspace.teacherMembershipId, userId: scope.acting.teacherUserId },
            ctx: null,
            zone: workspace.zone,
            history: { floor: workspace.floor, zone: workspace.zone },
            branch: { centerId: workspace.centerId, centerName: workspace.centerName, floor: workspace.floor },
            isPrivate: true,
            readOnly: workspace.archivedAt ? "workspaceArchived" : null,
          },
        ]
      : [],
  );
  return [...resolved.filter((entry): entry is AssistantAssessmentBranch => entry !== null), ...workspaces];
}

/** A session or row date inside the assistant's floor at that place (no floor = the teacher keeps all history). */
export function withinAssistantFloor(entry: AssistantAssessmentBranch, date: Date): boolean {
  return entry.branch.floor === null || date >= entry.branch.floor;
}
