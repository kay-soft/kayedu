import { notFound } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { requirePermission, type TenantContext } from "@/lib/auth/tenant";
import { firstGranting, type TeacherScope } from "@/lib/auth/teacher-scope";
import { getWorkspaceContext, workspaceOffersWrites, type WorkspaceContext } from "@/lib/auth/workspace-context";
import { resolveAssessmentTeacher, type AssessmentTeacher, type TeacherHistory } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { teacherPortalHistoryFloor } from "@/lib/db/teacher-portal";
import { listOwnedWorkspaces } from "@/lib/db/workspaces";
import { centreTimeZone } from "@/lib/scheduling";

/**
 * One place the teacher's exams and homework live: a branch, or (W9) one of
 * their PERSONAL workspaces. `ctx.center.kind` tells them apart; a workspace's
 * `ctx` is its own (`getWorkspaceContext`, the owner's — never one of the
 * branch scope's contexts).
 */
export type AssessmentBranch = { ctx: TenantContext; teacher: AssessmentTeacher; zone: string; history: TeacherHistory };

/**
 * Which of the teacher's workspaces a read takes: every one (the default — a
 * page that finds a row by id), none (a Source filter naming a branch), or one
 * (a Source filter naming that workspace).
 */
export type WorkspaceChoice = "all" | "none" | { id: string };

/**
 * The branches (of those given) where this teacher may manage assessments —
 * `resolveAssessmentTeacher` at each, a union of per-branch checks (U7). A
 * branch whose Owner switched `assessment.manage.own` off contributes nothing.
 *
 * W9 (D-W42 items 1, 7): **plus the signed-in teacher's own PERSONAL
 * workspaces**, each resolved under its own context (`getWorkspaceContext` —
 * the owner only) and authorised by `workspaceCan(…, "workspace.assessments.manage")`
 * inside `resolveAssessmentTeacher`. Archived and lapsed workspaces are
 * included: reads never need premium. The window is the teacher's own
 * `teacherHistoryDays` everywhere (U6). Workspaces are never part of the
 * branch scope; they are unioned here, one scoped read each (rule 1).
 */
export async function assessmentBranches(branches: TenantContext[], workspaces: WorkspaceChoice = "all"): Promise<AssessmentBranch[]> {
  const [resolved, owned] = await Promise.all([
    Promise.all(branches.map(fromContext)),
    teacherWorkspaceSources(workspaces),
  ]);
  return [...resolved, ...owned].filter((entry): entry is AssessmentBranch => entry !== null);
}

async function fromContext(ctx: TenantContext): Promise<AssessmentBranch | null> {
  const zone = centreTimeZone(ctx.settings);
  const teacher = await resolveAssessmentTeacher(prisma, ctx);
  return teacher ? { ctx, teacher, zone, history: { floor: teacherPortalHistoryFloor(ctx), zone } } : null;
}

async function teacherWorkspaceSources(choice: WorkspaceChoice): Promise<(AssessmentBranch | null)[]> {
  if (choice === "none") return [];
  const user = await getCurrentUser();
  if (!user) return [];
  const owned = await listOwnedWorkspaces(prisma, user.id);
  const wanted = choice === "all" ? owned : owned.filter((workspace) => workspace.id === choice.id);
  return Promise.all(
    wanted.map(async (workspace) => {
      const ctx = await getWorkspaceContext(workspace.id);
      return ctx ? fromContext(ctx) : null;
    }),
  );
}

/** The teacher's own workspaces, for a Source filter (id and name), active first. */
export async function teacherWorkspaceOptions(userId: string): Promise<{ id: string; name: string }[]> {
  return (await listOwnedWorkspaces(prisma, userId)).map((workspace) => ({ id: workspace.id, name: workspace.name }));
}


/**
 * W9 (D-W42 item 5): why a source takes no teacher writes now — a PERSONAL
 * workspace whose owner is not premium on this request, or that is archived —
 * or null (every branch, and a writable workspace). A display decision only:
 * every writer re-checks it (`workspaceWriteGate`).
 */
export function assessmentReadOnlyReason(source: AssessmentBranch, now: Date = new Date()): "premiumRequired" | "workspaceArchived" | null {
  const ctx = source.ctx as Partial<WorkspaceContext> & TenantContext;
  if (!ctx.workspace) return null;
  if (ctx.workspace.archivedAt) return "workspaceArchived";
  return workspaceOffersWrites(ctx as WorkspaceContext, now) ? null : "premiumRequired";
}

/**
 * The page gate (D-W30, W9): with no source at all, a teacher at a branch meets
 * the branch's `assessment.manage.own` check as before; a workspace-only
 * teacher with nothing to read gets not-found.
 */
export async function requireAssessmentSources(scope: TeacherScope, sources: AssessmentBranch[]): Promise<void> {
  if (sources.length > 0) return;
  if (scope.inView.length > 0) {
    await requirePermission(firstGranting(scope, "assessment.manage.own"), "assessment.manage.own");
    return;
  }
  notFound();
}
