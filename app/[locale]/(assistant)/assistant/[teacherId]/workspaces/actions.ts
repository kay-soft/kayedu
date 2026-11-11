"use server";

import { revalidatePath } from "next/cache";

import { assistantActionScope, scopeWorkspace, type AssistantScope } from "@/lib/auth/assistant-context";
import { prisma } from "@/lib/db/client";
import {
  workspaceCheckIn,
  workspaceCloseSession,
  workspaceRecordPayment,
  workspaceRefundPayment,
  workspaceSetAttendance,
  workspaceVoidPayment,
  type WorkspaceActor,
} from "@/lib/db/workspace-attendance";
import { ROUTES } from "@/lib/routes";
import { assistantTeacherRefSchema } from "@/lib/validation/assistants";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  workspaceCheckInSchema,
  workspaceCloseSessionSchema,
  workspaceRecordPaymentSchema,
  workspaceReversalSchema,
  workspaceSetAttendanceSchema,
  type WorkspaceSessionActionState,
} from "@/lib/validation/workspace-sessions";

/**
 * An assistant's check-in and payments in the teacher's PERSONAL workspace
 * (W8d, D-W41 items 9, 10). The teacher comes from the route segment and is
 * re-resolved with the session's user (`assistantActionScope`) before
 * anything else; the posted workspace id is accepted only when it is one of
 * **the teacher's own** workspaces in that scope (`scopeWorkspace`). The
 * writers in `lib/db/workspace-attendance.ts` then run the whole decision
 * again inside their own transaction — the link, `assistantCan`
 * (`checkin.workspace` / `payments.workspace`), the teacher's capability,
 * premium and "not archived", the assistant's window — and audit every row
 * with actor = the assistant and onBehalfOf = the teacher (D-W18), with the
 * teacher's own action names. No amount, method, user or centre id is ever
 * posted. Nothing here is the boundary.
 */

const FORBIDDEN: WorkspaceSessionActionState = { error: "forbidden" };
const NOT_FOUND: WorkspaceSessionActionState = { error: "notFound" };

/** Actor = the assistant (the session's user); for = the teacher the scope resolved. */
function actorOf(scope: AssistantScope): WorkspaceActor {
  return { actorUserId: scope.user.id, teacherUserId: scope.acting.teacherUserId };
}

function revalidateSession(locale: string, teacherId: string, workspaceId: string, sessionId: string): void {
  revalidatePath(`/${locale}${ROUTES.assistantWorkspaceSession(teacherId, workspaceId, sessionId)}`);
  revalidatePath(`/${locale}${ROUTES.assistantWorkspaceSessions(teacherId, workspaceId)}`);
}

export async function assistantWorkspaceCheckInAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  const parsed = workspaceCheckInSchema.safeParse(entries);
  if (!who.success || !parsed.success) return NOT_FOUND;
  const { teacherId } = who.data;
  const { locale, workspaceId, sessionId, studentProfileId } = parsed.data;

  const scope = await assistantActionScope(teacherId);
  if (!scope) return FORBIDDEN;
  const workspace = scopeWorkspace(scope, workspaceId);
  if (!workspace) return NOT_FOUND;
  const result = await workspaceCheckIn(prisma, actorOf(scope), workspace.centerId, { sessionId, studentProfileId });
  revalidateSession(locale, teacherId, workspace.centerId, sessionId);
  if (!result.ok) return { error: result.error };
  return { status: "checkedIn" };
}

export async function assistantWorkspaceSetAttendanceAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  if (!who.success) return NOT_FOUND;
  const parsed = workspaceSetAttendanceSchema.safeParse(entries);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { teacherId } = who.data;
  const { locale, workspaceId, sessionId, studentProfileId, status, reason, confirmVoid } = parsed.data;

  const scope = await assistantActionScope(teacherId);
  if (!scope) return FORBIDDEN;
  const workspace = scopeWorkspace(scope, workspaceId);
  if (!workspace) return NOT_FOUND;
  const result = await workspaceSetAttendance(prisma, actorOf(scope), workspace.centerId, {
    sessionId,
    studentProfileId,
    status,
    reason,
    confirmVoid,
  });
  revalidateSession(locale, teacherId, workspace.centerId, sessionId);
  if (!result.ok) return result.error === "reasonRequired" ? { fieldErrors: { reason: "reasonRequired" } } : { error: result.error };
  return { status: result.voidedPayment ? "voided" : "saved" };
}

export async function assistantWorkspaceRecordPaymentAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  const parsed = workspaceRecordPaymentSchema.safeParse(entries);
  if (!who.success || !parsed.success) return NOT_FOUND;
  const { teacherId } = who.data;
  const { locale, workspaceId, sessionId, attendeeId } = parsed.data;

  const scope = await assistantActionScope(teacherId);
  if (!scope) return FORBIDDEN;
  const workspace = scopeWorkspace(scope, workspaceId);
  if (!workspace) return NOT_FOUND;
  const result = await workspaceRecordPayment(prisma, actorOf(scope), workspace.centerId, { attendeeId });
  revalidateSession(locale, teacherId, workspace.centerId, sessionId);
  if (!result.ok) return { error: result.error };
  return { status: "paid" };
}

export async function assistantWorkspaceVoidPaymentAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  if (!who.success) return NOT_FOUND;
  const parsed = workspaceReversalSchema.safeParse(entries);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { teacherId } = who.data;
  const { locale, workspaceId, sessionId, paymentId, reason } = parsed.data;

  const scope = await assistantActionScope(teacherId);
  if (!scope) return FORBIDDEN;
  const workspace = scopeWorkspace(scope, workspaceId);
  if (!workspace) return NOT_FOUND;
  const result = await workspaceVoidPayment(prisma, actorOf(scope), workspace.centerId, { paymentId, reason });
  revalidateSession(locale, teacherId, workspace.centerId, sessionId);
  if (!result.ok) return result.error === "reasonRequired" ? { fieldErrors: { reason: "required" } } : { error: result.error };
  return { status: "voided" };
}

export async function assistantWorkspaceRefundPaymentAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  if (!who.success) return NOT_FOUND;
  const parsed = workspaceReversalSchema.safeParse(entries);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { teacherId } = who.data;
  const { locale, workspaceId, sessionId, paymentId, reason } = parsed.data;

  const scope = await assistantActionScope(teacherId);
  if (!scope) return FORBIDDEN;
  const workspace = scopeWorkspace(scope, workspaceId);
  if (!workspace) return NOT_FOUND;
  const result = await workspaceRefundPayment(prisma, actorOf(scope), workspace.centerId, { paymentId, reason });
  revalidateSession(locale, teacherId, workspace.centerId, sessionId);
  if (!result.ok) return result.error === "reasonRequired" ? { fieldErrors: { reason: "required" } } : { error: result.error };
  return { status: "refunded" };
}

export async function assistantWorkspaceCloseSessionAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  const parsed = workspaceCloseSessionSchema.safeParse(entries);
  if (!who.success || !parsed.success) return NOT_FOUND;
  const { teacherId } = who.data;
  const { locale, workspaceId, sessionId } = parsed.data;

  const scope = await assistantActionScope(teacherId);
  if (!scope) return FORBIDDEN;
  const workspace = scopeWorkspace(scope, workspaceId);
  if (!workspace) return NOT_FOUND;
  const result = await workspaceCloseSession(prisma, actorOf(scope), workspace.centerId, { sessionId });
  revalidateSession(locale, teacherId, workspace.centerId, sessionId);
  if (!result.ok) return { error: result.error };
  return { status: "closed" };
}
