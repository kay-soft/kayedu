"use server";

import { revalidatePath } from "next/cache";

import { clientIp } from "@/lib/auth/request-ip";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { previewWorkspaceShareCode, redeemWorkspaceShareCode } from "@/lib/db/workspace-share-codes";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import { workspaceShareCodeSchema, type WorkspaceJoinState } from "@/lib/validation/workspace-share-codes";

/**
 * `/workspace-join` (W10, D-W43): redeeming a workspace share code. The
 * acting account is always the session's. Two calls — a preview that writes
 * nothing (the workspace's name and its teacher's), then the confirm that
 * links — and every rule (rate limit, one answer for an unusable code, the
 * refusals, single use, the W8b move, audit) lives in
 * `lib/db/workspace-share-codes.ts`. Error keys resolve under `WorkspaceJoin.errors`.
 */

function revalidateStudentSurfaces(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.selectCenter}`);
  revalidatePath(`/${locale}${ROUTES.studentSchedule}`);
  revalidatePath(`/${locale}${ROUTES.studentCalendar}`);
  revalidatePath(`/${locale}`, "layout");
}

/** Step one: what the code would link — shown for the person to confirm. */
export async function previewWorkspaceShareCodeAction(
  _state: WorkspaceJoinState,
  formData: FormData,
): Promise<WorkspaceJoinState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = workspaceShareCodeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const result = await previewWorkspaceShareCode(prisma, { userId: user.id, code: parsed.data.code, ip: await clientIp() });
  if (!result.ok) return { error: result.error };
  return { status: "preview", preview: { workspaceName: result.workspaceName, teacherName: result.teacherName } };
}

/** Step two, only from the confirmation's Confirm: the link. */
export async function redeemWorkspaceShareCodeAction(
  _state: WorkspaceJoinState,
  formData: FormData,
): Promise<WorkspaceJoinState> {
  const user = await getCurrentUser();
  if (!user) return { error: "signInRequired" };
  const parsed = workspaceShareCodeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const result = await redeemWorkspaceShareCode(prisma, { userId: user.id, code: parsed.data.code, ip: await clientIp() });
  if (!result.ok) return { error: result.error };
  revalidateStudentSurfaces(parsed.data.locale);
  return { status: "joined" };
}
