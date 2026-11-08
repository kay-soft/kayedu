"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import {
  workspaceCheckIn,
  workspaceCloseSession,
  workspaceRecordPayment,
  workspaceRefundPayment,
  workspaceSetAttendance,
  workspaceVoidPayment,
} from "@/lib/db/workspace-attendance";
import { ROUTES } from "@/lib/routes";
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
 * Teacher → Workspaces → a session's roster (W8c, D-W40). Every action takes
 * the actor from the session — never a posted user — and hands the posted
 * workspace id to `lib/db/workspace-attendance.ts`, which re-resolves it for
 * that owner, decides `workspaceCan`, adds premium and "not archived", and
 * calls the unchanged branch engine. No amount and no method is ever posted.
 * In W8c the actor is the teacher (D-W40 item 7). Nothing here is the boundary.
 */

const FORBIDDEN: WorkspaceSessionActionState = { error: "forbidden" };
const NOT_FOUND: WorkspaceSessionActionState = { error: "notFound" };

function revalidateSession(locale: string, workspaceId: string, sessionId: string): void {
  revalidatePath(`/${locale}${ROUTES.teacherWorkspaceSession(workspaceId, sessionId)}`);
  revalidatePath(`/${locale}${ROUTES.teacherWorkspaceSessions(workspaceId)}`);
}

export async function workspaceCheckInAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceCheckInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, sessionId, studentProfileId } = parsed.data;
  const result = await workspaceCheckIn(prisma, { actorUserId: user.id, teacherUserId: user.id }, workspaceId, { sessionId, studentProfileId });
  revalidateSession(locale, workspaceId, sessionId);
  if (!result.ok) return { error: result.error };
  return { status: "checkedIn" };
}

export async function workspaceSetAttendanceAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceSetAttendanceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, sessionId, studentProfileId, status, reason, confirmVoid } = parsed.data;
  const result = await workspaceSetAttendance(prisma, { actorUserId: user.id, teacherUserId: user.id }, workspaceId, {
    sessionId,
    studentProfileId,
    status,
    reason,
    confirmVoid,
  });
  revalidateSession(locale, workspaceId, sessionId);
  if (!result.ok) return result.error === "reasonRequired" ? { fieldErrors: { reason: "reasonRequired" } } : { error: result.error };
  return { status: result.voidedPayment ? "voided" : "saved" };
}

export async function workspaceRecordPaymentAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceRecordPaymentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, sessionId, attendeeId } = parsed.data;
  const result = await workspaceRecordPayment(prisma, { actorUserId: user.id, teacherUserId: user.id }, workspaceId, { attendeeId });
  revalidateSession(locale, workspaceId, sessionId);
  if (!result.ok) return { error: result.error };
  return { status: "paid" };
}

export async function workspaceVoidPaymentAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceReversalSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, sessionId, paymentId, reason } = parsed.data;
  const result = await workspaceVoidPayment(prisma, { actorUserId: user.id, teacherUserId: user.id }, workspaceId, { paymentId, reason });
  revalidateSession(locale, workspaceId, sessionId);
  if (!result.ok) return result.error === "reasonRequired" ? { fieldErrors: { reason: "required" } } : { error: result.error };
  return { status: "voided" };
}

export async function workspaceRefundPaymentAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceReversalSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, sessionId, paymentId, reason } = parsed.data;
  const result = await workspaceRefundPayment(prisma, { actorUserId: user.id, teacherUserId: user.id }, workspaceId, { paymentId, reason });
  revalidateSession(locale, workspaceId, sessionId);
  if (!result.ok) return result.error === "reasonRequired" ? { fieldErrors: { reason: "required" } } : { error: result.error };
  return { status: "refunded" };
}

export async function workspaceCloseSessionAction(
  _state: WorkspaceSessionActionState,
  formData: FormData,
): Promise<WorkspaceSessionActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceCloseSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, sessionId } = parsed.data;
  const result = await workspaceCloseSession(prisma, { actorUserId: user.id, teacherUserId: user.id }, workspaceId, { sessionId });
  revalidateSession(locale, workspaceId, sessionId);
  if (!result.ok) return { error: result.error };
  return { status: "closed" };
}
