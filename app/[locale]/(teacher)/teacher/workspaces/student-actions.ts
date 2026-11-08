"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import {
  addWorkspaceStudent,
  cancelWorkspaceInvitation,
  copyWorkspaceStudent,
  enrolWorkspaceStudent,
  inviteWorkspaceStudentAgain,
  removeWorkspaceEnrollment,
} from "@/lib/db/workspace-students";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  workspaceEnrollSchema,
  workspaceEnrollmentRecordSchema,
  workspaceStudentAddSchema,
  workspaceStudentCopySchema,
  workspaceStudentRecordSchema,
  type WorkspaceStudentActionState,
} from "@/lib/validation/workspace-students";

/**
 * Teacher → Workspaces → Students and a class's roster (W8b, D-W39). Every
 * action takes the actor from the session — never a posted user — and hands
 * the posted workspace id to `lib/db/workspace-students.ts`, which re-resolves
 * it for that owner, decides `workspaceCan`, and (for every write but Cancel
 * invitation) adds premium and "not archived". The add and "Invite again"
 * answer the same whether or not an account matched. Nothing here is the
 * boundary.
 */

const FORBIDDEN: WorkspaceStudentActionState = { error: "forbidden" };
const NOT_FOUND: WorkspaceStudentActionState = { error: "notFound" };

/** The add's refusals that belong to a field. */
const ADD_FIELD_ERRORS: Record<string, string> = {
  invalidPhone: "phone",
  duplicatePhone: "phone",
  nameRequired: "firstName",
  gradeNotFound: "gradeId",
};

function revalidateStudents(locale: string, workspaceId: string, classId?: string): void {
  revalidatePath(`/${locale}${ROUTES.teacherWorkspaceStudents(workspaceId)}`);
  if (classId) revalidatePath(`/${locale}${ROUTES.teacherWorkspaceClass(workspaceId, classId)}`);
}

function addRefusal(error: string): WorkspaceStudentActionState {
  const field = ADD_FIELD_ERRORS[error];
  return field ? { fieldErrors: { [field]: error } } : { error };
}

export async function addWorkspaceStudentAction(
  _state: WorkspaceStudentActionState,
  formData: FormData,
): Promise<WorkspaceStudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceStudentAddSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, firstName, lastName, phone, gradeId } = parsed.data;
  const result = await addWorkspaceStudent(prisma, user.id, workspaceId, { firstName, lastName, phone, gradeId });
  if (!result.ok) return addRefusal(result.error);
  revalidateStudents(locale, workspaceId);
  return { status: "added" };
}

export async function copyWorkspaceStudentAction(
  _state: WorkspaceStudentActionState,
  formData: FormData,
): Promise<WorkspaceStudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceStudentCopySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, source } = parsed.data;
  const result = await copyWorkspaceStudent(prisma, user.id, workspaceId, source);
  if (!result.ok) return result.error === "duplicatePhone" ? { fieldErrors: { source: "duplicatePhone" } } : addRefusal(result.error);
  revalidateStudents(locale, workspaceId);
  return { status: "added" };
}

export async function inviteWorkspaceStudentAgainAction(
  _state: WorkspaceStudentActionState,
  formData: FormData,
): Promise<WorkspaceStudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceStudentRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, studentProfileId } = parsed.data;
  const result = await inviteWorkspaceStudentAgain(prisma, user.id, workspaceId, studentProfileId);
  if (!result.ok) return { error: result.error };
  revalidateStudents(locale, workspaceId);
  return { status: "invited" };
}

export async function cancelWorkspaceInvitationAction(
  _state: WorkspaceStudentActionState,
  formData: FormData,
): Promise<WorkspaceStudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceStudentRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, studentProfileId } = parsed.data;
  const result = await cancelWorkspaceInvitation(prisma, user.id, workspaceId, studentProfileId);
  if (!result.ok) return { error: result.error };
  revalidateStudents(locale, workspaceId);
  return { status: "cancelled" };
}

export async function enrolWorkspaceStudentAction(
  _state: WorkspaceStudentActionState,
  formData: FormData,
): Promise<WorkspaceStudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceEnrollSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, classId, studentProfileId } = parsed.data;
  const result = await enrolWorkspaceStudent(prisma, user.id, workspaceId, classId, studentProfileId);
  if (!result.ok) return { error: result.error };
  revalidateStudents(locale, workspaceId, classId);
  return { status: "enrolled" };
}

export async function removeWorkspaceEnrollmentAction(
  _state: WorkspaceStudentActionState,
  formData: FormData,
): Promise<WorkspaceStudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceEnrollmentRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, classId, enrollmentId } = parsed.data;
  const result = await removeWorkspaceEnrollment(prisma, user.id, workspaceId, enrollmentId);
  if (!result.ok) return { error: result.error };
  revalidateStudents(locale, workspaceId, classId);
  return { status: "removed" };
}
