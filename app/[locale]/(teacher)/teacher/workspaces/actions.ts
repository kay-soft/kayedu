"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { describeConflicts } from "@/lib/db/slot-conflicts";
import {
  archiveWorkspace,
  cancelWorkspaceSession,
  createWorkspace,
  createWorkspaceClass,
  createWorkspaceSession,
  deleteWorkspaceClass,
  deleteWorkspaceSession,
  renameWorkspace,
  rescheduleWorkspaceSession,
  setWorkspaceClassActive,
  unarchiveWorkspace,
  updateWorkspaceClass,
  writeWorkspaceClassSlot,
} from "@/lib/db/workspaces";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  workspaceClassActiveSchema,
  workspaceClassCreateSchema,
  workspaceClassRecordSchema,
  workspaceClassUpdateSchema,
  workspaceCreateSchema,
  workspaceRecordSchema,
  workspaceRenameSchema,
  workspaceRescheduleSchema,
  workspaceSessionCreateSchema,
  workspaceSessionRecordSchema,
  workspaceSlotCreateSchema,
  workspaceSlotRemoveSchema,
  type WorkspaceActionState,
} from "@/lib/validation/workspaces";
import type { DatedConflict } from "@/lib/db/sessions";

/**
 * Teacher → Workspaces (W8a, D-W38; docs/04 §11.37). Every action takes the
 * actor from the session — never a posted user — and hands the posted
 * workspace id to `lib/db/workspaces.ts`, whose writers re-resolve it for that
 * owner (another account's id is `notFound`), decide `workspaceCan`, and add
 * premium and "not archived" for every write but Archive. The class and
 * session writes are the class engine's own, with the workspace's forced
 * values. Nothing here is the boundary.
 */

const FORBIDDEN: WorkspaceActionState = { error: "forbidden" };
const NOT_FOUND: WorkspaceActionState = { error: "notFound" };
const MAX_SHOWN_CONFLICTS = 30;

const PERIOD_ERRORS = new Set(["endBeforeStart", "periodTooLong"]);
const SLOT_ERRORS = new Set(["slotsRequired", "slotOverlap", "invalidDay", "invalidTime", "invalidTimeRange"]);
const CATALOG_FIELDS: Record<string, string> = {
  educationSystemNotFound: "educationSystemId",
  gradeNotFound: "gradeId",
  subjectNotFound: "subjectId",
  subjectNotInGrade: "subjectId",
};

/** A refused class or session write → the form's state (field errors where a field caused it). */
async function refusal(
  workspaceId: string,
  result: { ok: false; error: string; conflicts?: DatedConflict[]; policy?: "WARN" | "DENY"; blockers?: unknown; active?: number },
): Promise<WorkspaceActionState> {
  if (result.conflicts) {
    const policy = result.error === "conflict" ? "DENY" : (result.policy ?? "WARN");
    return {
      error: result.error === "conflict" ? "scheduleConflict" : "conflictsNeedConfirmation",
      conflicts: await describeConflicts(prisma, workspaceId, result.conflicts.slice(0, MAX_SHOWN_CONFLICTS)),
      conflictPolicy: policy,
    };
  }
  if (PERIOD_ERRORS.has(result.error)) return { fieldErrors: { endDate: result.error } };
  if (result.error === "invalidPrice") return { fieldErrors: { price: "invalidAmount" } };
  if (SLOT_ERRORS.has(result.error)) return { fieldErrors: { slots: result.error } };
  const catalogField = CATALOG_FIELDS[result.error];
  if (catalogField) return { fieldErrors: { [catalogField]: result.error === "subjectNotInGrade" ? "subjectNotInGrade" : "notFound" } };
  if (result.error === "workspaceCapReached") return { error: result.error, errorValues: { active: result.active ?? 0 } };
  if (result.error === "classInUse" || result.error === "sessionInUse") {
    return { error: result.error };
  }
  return { error: result.error };
}

function revalidateWorkspace(locale: string, workspaceId: string, classId?: string): void {
  revalidatePath(`/${locale}${ROUTES.teacherWorkspaces}`);
  revalidatePath(`/${locale}${ROUTES.teacherWorkspace(workspaceId)}`, "layout");
  if (classId) revalidatePath(`/${locale}${ROUTES.teacherWorkspaceClass(workspaceId, classId)}`);
}

function sessionsOf(report: { created: number; deleted: number; updated: number; kept: unknown[] } | null | undefined) {
  return report
    ? { created: report.created, deleted: report.deleted, updated: report.updated, kept: report.kept.length }
    : undefined;
}

// ── The workspace itself ───────────────────────────────────────────────────

export async function createWorkspaceAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const result = await createWorkspace(prisma, user.id, { name: parsed.data.name });
  if (!result.ok) {
    if (result.error === "invalidName") return { fieldErrors: { name: "nameRequired" } };
    return refusal("", result);
  }
  revalidatePath(`/${parsed.data.locale}${ROUTES.teacherWorkspaces}`);
  redirect({ href: ROUTES.teacherWorkspace(result.workspaceId), locale: parsed.data.locale });
  return { status: "created", workspaceId: result.workspaceId };
}

export async function renameWorkspaceAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceRenameSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, name } = parsed.data;
  const result = await renameWorkspace(prisma, user.id, workspaceId, name);
  if (!result.ok) {
    if (result.error === "invalidName") return { fieldErrors: { name: "nameRequired" } };
    return { error: result.error };
  }
  revalidateWorkspace(locale, workspaceId);
  return { status: "saved" };
}

export async function archiveWorkspaceAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId } = parsed.data;
  const result = await archiveWorkspace(prisma, user.id, workspaceId);
  if (!result.ok) return { error: result.error };
  revalidateWorkspace(locale, workspaceId);
  return {
    status: "archived",
    sessions: { created: 0, deleted: result.sessionsDeleted, updated: 0, kept: 0, cancelled: result.sessionsCancelled },
  };
}

export async function unarchiveWorkspaceAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId } = parsed.data;
  const result = await unarchiveWorkspace(prisma, user.id, workspaceId);
  if (!result.ok) return refusal(workspaceId, result);
  revalidateWorkspace(locale, workspaceId);
  return { status: "unarchived" };
}

// ── Classes ────────────────────────────────────────────────────────────────

export async function createWorkspaceClassAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceClassCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, confirmConflicts, centerShareType, shareValue, slots, ...fields } = parsed.data;
  const result = await createWorkspaceClass(
    prisma,
    user.id,
    workspaceId,
    {
      ...fields,
      slots,
      centerShareType: centerShareType === "INVALID" ? ("FIXED" as const) : centerShareType,
      centerShareValue: shareValue,
    },
    { confirmConflicts, locale },
  );
  if (!result.ok) return refusal(workspaceId, result);
  revalidateWorkspace(locale, workspaceId, result.classGroupId);
  return { status: "created", sessions: sessionsOf(result.report) };
}

export async function updateWorkspaceClassAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceClassUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, classId, confirmConflicts, centerShareType, shareValue, ...fields } = parsed.data;
  const result = await updateWorkspaceClass(
    prisma,
    user.id,
    workspaceId,
    classId,
    {
      ...fields,
      centerShareType: centerShareType === "INVALID" ? ("FIXED" as const) : centerShareType,
      centerShareValue: shareValue,
    },
    { confirmConflicts, locale },
  );
  if (!result.ok) return refusal(workspaceId, result);
  revalidateWorkspace(locale, workspaceId, classId);
  return { status: "saved", sessions: sessionsOf(result.report) };
}

export async function setWorkspaceClassActiveAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceClassActiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, classId, active, confirmConflicts } = parsed.data;
  const result = await setWorkspaceClassActive(prisma, user.id, workspaceId, classId, active, { confirmConflicts, locale });
  if (!result.ok) {
    if (result.error === "alreadyActive" || result.error === "alreadyInactive") return { status: "saved" };
    return refusal(workspaceId, result);
  }
  revalidateWorkspace(locale, workspaceId, classId);
  if ("report" in result) return { status: "saved", sessions: sessionsOf(result.report) };
  return { status: "saved", sessions: { created: 0, deleted: result.deleted, updated: 0, kept: 0, cancelled: result.cancelled } };
}

export async function deleteWorkspaceClassAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceClassRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, classId } = parsed.data;
  const result = await deleteWorkspaceClass(prisma, user.id, workspaceId, classId);
  if (!result.ok) return refusal(workspaceId, result);
  revalidateWorkspace(locale, workspaceId);
  // The control lives on the class's own page: leave it before the refresh 404s.
  redirect({ href: ROUTES.teacherWorkspace(workspaceId), locale });
  return { status: "deleted" };
}

export async function addWorkspaceSlotAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceSlotCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, classId, dayOfWeek, startTime, endTime, confirmConflicts } = parsed.data;
  const result = await writeWorkspaceClassSlot(
    prisma,
    user.id,
    workspaceId,
    { kind: "add", classGroupId: classId, slot: { dayOfWeek, startTime, endTime } },
    { confirmConflicts, locale },
  );
  if (!result.ok) return refusal(workspaceId, result);
  revalidateWorkspace(locale, workspaceId, classId);
  return { status: "created", sessions: sessionsOf(result.report) };
}

export async function removeWorkspaceSlotAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceSlotRemoveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, scheduleId, confirmConflicts } = parsed.data;
  const result = await writeWorkspaceClassSlot(
    prisma,
    user.id,
    workspaceId,
    { kind: "remove", scheduleId },
    { confirmConflicts, locale },
  );
  if (!result.ok) return refusal(workspaceId, result);
  revalidateWorkspace(locale, workspaceId);
  revalidatePath(`/${locale}${ROUTES.teacherWorkspace(workspaceId)}`, "layout");
  return { status: "deleted", sessions: sessionsOf(result.report) };
}

// ── Sessions ───────────────────────────────────────────────────────────────

export async function createWorkspaceSessionAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceSessionCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, confirmConflicts } = parsed.data;
  const input =
    parsed.data.kind === "extra"
      ? { kind: "extra" as const, classGroupId: parsed.data.classId, date: parsed.data.date, startTime: parsed.data.startTime, endTime: parsed.data.endTime }
      : {
          kind: "oneOff" as const,
          title: parsed.data.title,
          price: parsed.data.price,
          date: parsed.data.date,
          startTime: parsed.data.startTime,
          endTime: parsed.data.endTime,
        };
  const result = await createWorkspaceSession(prisma, user.id, workspaceId, input, { confirmConflicts, locale });
  if (!result.ok) return refusal(workspaceId, result);
  revalidateWorkspace(locale, workspaceId, parsed.data.kind === "extra" ? parsed.data.classId : undefined);
  return { status: "created" };
}

export async function rescheduleWorkspaceSessionAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceRescheduleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, workspaceId, sessionId, date, startTime, endTime, confirmConflicts } = parsed.data;
  const result = await rescheduleWorkspaceSession(prisma, user.id, workspaceId, sessionId, { date, startTime, endTime }, {
    confirmConflicts,
    locale,
  });
  if (!result.ok) return refusal(workspaceId, result);
  revalidateWorkspace(locale, workspaceId);
  return { status: "rescheduled" };
}

export async function cancelWorkspaceSessionAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceSessionRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, sessionId } = parsed.data;
  const result = await cancelWorkspaceSession(prisma, user.id, workspaceId, sessionId);
  if (!result.ok) return { error: result.error };
  revalidateWorkspace(locale, workspaceId);
  return { status: "cancelled" };
}

export async function deleteWorkspaceSessionAction(
  _state: WorkspaceActionState,
  formData: FormData,
): Promise<WorkspaceActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;
  const parsed = workspaceSessionRecordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, workspaceId, sessionId } = parsed.data;
  const result = await deleteWorkspaceSession(prisma, user.id, workspaceId, sessionId);
  if (!result.ok) return { error: result.error };
  revalidateWorkspace(locale, workspaceId);
  return { status: "deleted" };
}
