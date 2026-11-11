"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { createWorkspaceShareCode, revokeWorkspaceShareCode } from "@/lib/db/workspace-share-codes";
import { ROUTES } from "@/lib/routes";
import type { WorkspaceShareCodeActionState } from "@/lib/validation/workspace-share-codes";
import { workspaceStudentRecordSchema } from "@/lib/validation/workspace-students";

/**
 * Teacher → Workspaces → Students: "Share code" and "Revoke code" (W10,
 * D-W43). Every action takes the actor from the session — never a posted
 * user — and hands the posted workspace and profile to
 * `lib/db/workspace-share-codes.ts`, which re-resolves the workspace for that
 * owner, decides `workspaceCan`, and (for Share code) adds premium and "not
 * archived". Nothing here is the boundary. Error keys resolve under
 * `WorkspaceStudents.errors`, then `Workspaces.errors`.
 */

function revalidateStudents(locale: string, workspaceId: string): void {
  revalidatePath(`/${locale}${ROUTES.teacherWorkspaceStudents(workspaceId)}`);
}

/** "Share code": the code comes back **once**, in this answer only (it is stored hashed). */
export async function createWorkspaceShareCodeAction(
  _state: WorkspaceShareCodeActionState,
  formData: FormData,
): Promise<WorkspaceShareCodeActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "forbidden" };
  const parsed = workspaceStudentRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, workspaceId, studentProfileId } = parsed.data;
  const result = await createWorkspaceShareCode(prisma, user.id, workspaceId, studentProfileId);
  if (!result.ok) return { error: result.error };
  revalidateStudents(locale, workspaceId);
  return { status: "created", code: result.code, expiresAt: result.expiresAt.toISOString() };
}

/** "Revoke code": reducing access, so no premium, and archived alike. */
export async function revokeWorkspaceShareCodeAction(
  _state: WorkspaceShareCodeActionState,
  formData: FormData,
): Promise<WorkspaceShareCodeActionState> {
  const user = await getCurrentUser();
  if (!user) return { error: "forbidden" };
  const parsed = workspaceStudentRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, workspaceId, studentProfileId } = parsed.data;
  const result = await revokeWorkspaceShareCode(prisma, user.id, workspaceId, studentProfileId);
  if (!result.ok) return { error: result.error === "notFound" ? "codeGone" : result.error };
  revalidateStudents(locale, workspaceId);
  return { status: "revoked" };
}
