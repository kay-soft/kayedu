"use server";

import { revalidatePath } from "next/cache";

import { assistantAssessmentBranches, withinAssistantFloor, type AssistantAssessmentBranch } from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/scope";
import { assistantActionScope } from "@/lib/auth/assistant-context";
import {
  createAssessment,
  deleteAssessment,
  extendAssessment,
  findOwnClassForExam,
  findOwnSessionForHomework,
  findTeacherAssessment,
  publishAssessment,
  saveAssessmentDraft,
  sessionZone,
  unpublishAssessment,
  type AssessmentWriteResult,
} from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { assessmentRoutes } from "@/lib/routes";
import {
  assessmentDeleteSchema,
  assessmentExtendSchema,
  assessmentFormSchema,
  assessmentPayloadSchema,
  draftFromPayload,
  instantFromFields,
  type AssessmentActionState,
} from "@/lib/validation/assessments";
import { assistantTeacherRefSchema } from "@/lib/validation/assistants";

/**
 * An assistant's assessment writes (W7b, D-W37 item 3) — the teacher's own
 * builder, publish, unpublish, extend and delete, on the teacher's behalf.
 *
 * Every action: the teacher comes from the posted route segment and is
 * re-resolved with the **session's** user (`assistantActionScope` — an
 * effective link, else `forbidden`); the branch comes from **the row** (the
 * assessment, the class or the session), found among the branches where
 * `assistantCan` grants `assessments.manage` — the posted `centerId` is
 * never read; the W2/W3a writers run unchanged with actor = the assistant and
 * owning teacher = the teacher's membership, and re-check the assistant inside
 * their own transaction (`assistantMayAt`), auditing both people (D-W18).
 */

const FORBIDDEN: AssessmentActionState = { error: "forbidden" };
const NOT_FOUND: AssessmentActionState = { error: "notFound" };

function refusal(result: Extract<AssessmentWriteResult, { ok: false }>): AssessmentActionState {
  if (result.error === "invalid") return { error: "invalid", draftErrors: result.errors };
  return { error: result.error };
}

function revalidateAssistant(locale: string, teacherId: string, assessmentId?: string) {
  const routes = assessmentRoutes({ kind: "assistant", teacherId });
  revalidatePath(`/${locale}${routes.list}`);
  if (assessmentId) revalidatePath(`/${locale}${routes.detail(assessmentId)}`);
}

/** The row among the manage branches, read within the assistant's window — a row outside it is not found. */
async function findManagedRow(branches: AssistantAssessmentBranch[], assessmentId: string) {
  for (const branch of branches) {
    const row = await findTeacherAssessment(prisma, branch.teacher, assessmentId, { history: branch.history });
    if (row) return { branch, row };
  }
  return null;
}

async function manageScope(teacherId: string) {
  const scope = await assistantActionScope(teacherId);
  if (!scope) return null;
  return { scope, branches: await assistantAssessmentBranches(scope, "assessments.manage") };
}

/** "Save draft" — creates the draft on its first save, then updates it. */
export async function assistantSaveAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  const parsed = assessmentFormSchema.safeParse(entries);
  if (!who.success || !parsed.success) return NOT_FOUND;
  const { teacherId } = who.data;
  const { locale, assessmentId, type, classGroupId, sessionId } = parsed.data;

  const managed = await manageScope(teacherId);
  if (!managed) return FORBIDDEN;

  let json: unknown;
  try {
    json = JSON.parse(parsed.data.payload);
  } catch {
    return { error: "invalid" };
  }
  const payload = assessmentPayloadSchema.safeParse(json);
  if (!payload.success) return { error: "invalid" };

  let branch: AssistantAssessmentBranch | undefined;
  let zone: string;
  let target: { classGroupId: string | null; sessionId: string | null };
  if (assessmentId) {
    const hit = await findManagedRow(managed.branches, assessmentId);
    if (!hit) return NOT_FOUND;
    branch = hit.branch;
    zone = hit.row.session ? sessionZone(hit.row.session, branch.zone) : branch.zone;
    target = { classGroupId: hit.row.classGroupId, sessionId: hit.row.sessionId };
  } else if (type === "HOMEWORK") {
    if (!sessionId) return NOT_FOUND;
    for (const candidate of managed.branches) {
      const session = await findOwnSessionForHomework(prisma, candidate.teacher, sessionId);
      if (session && withinAssistantFloor(candidate, session.date)) {
        branch = candidate;
        zone = sessionZone(session, candidate.zone);
        target = { classGroupId: session.classGroupId, sessionId: session.id };
        break;
      }
    }
    if (!branch) return NOT_FOUND;
  } else {
    if (!classGroupId) return NOT_FOUND;
    for (const candidate of managed.branches) {
      const classGroup = await findOwnClassForExam(prisma, candidate.teacher, classGroupId);
      if (classGroup) {
        branch = candidate;
        zone = candidate.zone;
        target = { classGroupId: classGroup.id, sessionId: null };
        break;
      }
    }
    if (!branch) return NOT_FOUND;
  }

  const { draft, badFields } = draftFromPayload(payload.data, zone!);
  if (badFields.length > 0) {
    return { error: "invalid", fieldErrors: Object.fromEntries(badFields.map((field) => [field, "badTime"])) };
  }

  const actor = { userId: managed.scope.user.id };
  if (assessmentId) {
    const result = await saveAssessmentDraft(prisma, actor, branch.teacher, assessmentId, draft);
    if (!result.ok) return refusal(result);
    revalidateAssistant(locale, teacherId, assessmentId);
    return { status: "saved", savedAt: Date.now() };
  }

  const result =
    type === "HOMEWORK"
      ? await createAssessment(prisma, actor, branch.teacher, { type, sessionId: target!.sessionId!, draft })
      : await createAssessment(prisma, actor, branch.teacher, { type, classGroupId: target!.classGroupId!, draft });
  if (!result.ok) return refusal(result);
  revalidateAssistant(locale, teacherId, result.id);
  redirect({ href: assessmentRoutes({ kind: "assistant", teacherId }).detail(result.id), locale });
  return { status: "saved", savedAt: Date.now() };
}

/** Deletes a draft, or a published row nobody has started (confirmed in the UI), then lands on the list. */
export async function assistantDeleteAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  const parsed = assessmentDeleteSchema.safeParse(entries);
  if (!who.success || !parsed.success) return NOT_FOUND;
  const { teacherId } = who.data;
  const { locale, assessmentId } = parsed.data;

  const managed = await manageScope(teacherId);
  if (!managed) return FORBIDDEN;
  const hit = await findManagedRow(managed.branches, assessmentId);
  if (!hit) return NOT_FOUND;
  const result = await deleteAssessment(prisma, { userId: managed.scope.user.id }, hit.branch.teacher, assessmentId);
  if (!result.ok) return refusal(result);
  revalidateAssistant(locale, teacherId);
  redirect({ href: assessmentRoutes({ kind: "assistant", teacherId }).list, locale });
  return { status: "deleted" };
}

/** DRAFT → PUBLISHED, refused unless "Ready to publish" is all done. */
export async function assistantPublishAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  const parsed = assessmentDeleteSchema.safeParse(entries);
  if (!who.success || !parsed.success) return NOT_FOUND;
  const { teacherId } = who.data;
  const { locale, assessmentId } = parsed.data;

  const managed = await manageScope(teacherId);
  if (!managed) return FORBIDDEN;
  const hit = await findManagedRow(managed.branches, assessmentId);
  if (!hit) return NOT_FOUND;
  const result = await publishAssessment(prisma, { userId: managed.scope.user.id }, hit.branch.teacher, assessmentId, new Date());
  if (!result.ok) return { error: result.error };
  revalidateAssistant(locale, teacherId, assessmentId);
  return { status: "published" };
}

/** PUBLISHED → DRAFT, only while no student has started. */
export async function assistantUnpublishAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  const parsed = assessmentDeleteSchema.safeParse(entries);
  if (!who.success || !parsed.success) return NOT_FOUND;
  const { teacherId } = who.data;
  const { locale, assessmentId } = parsed.data;

  const managed = await manageScope(teacherId);
  if (!managed) return FORBIDDEN;
  const hit = await findManagedRow(managed.branches, assessmentId);
  if (!hit) return NOT_FOUND;
  const result = await unpublishAssessment(prisma, { userId: managed.scope.user.id }, hit.branch.teacher, assessmentId);
  if (!result.ok) return { error: result.error };
  revalidateAssistant(locale, teacherId, assessmentId);
  return { status: "unpublished" };
}

/** A later closing time or deadline, typed in the session's frozen timezone, else the branch's. */
export async function assistantExtendAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  const parsed = assessmentExtendSchema.safeParse(entries);
  if (!who.success || !parsed.success) return NOT_FOUND;
  const { teacherId } = who.data;
  const { locale, assessmentId, date, time } = parsed.data;

  const managed = await manageScope(teacherId);
  if (!managed) return FORBIDDEN;
  const hit = await findManagedRow(managed.branches, assessmentId);
  if (!hit) return NOT_FOUND;
  const zone = hit.row.session ? sessionZone(hit.row.session, hit.branch.zone) : hit.branch.zone;
  const newEnd = instantFromFields({ date, time }, zone);
  if (newEnd === null || newEnd === "invalid") return { error: "badTime" };
  const result = await extendAssessment(prisma, { userId: managed.scope.user.id }, hit.branch.teacher, assessmentId, newEnd, new Date());
  if (!result.ok) return { error: result.error };
  revalidateAssistant(locale, teacherId, assessmentId);
  return { status: "extended" };
}
