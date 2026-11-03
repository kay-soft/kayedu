"use server";

import { revalidatePath } from "next/cache";

import { teacherBranchContext } from "@/lib/auth/teacher-scope";
import {
  createAssessment,
  deleteAssessment,
  findOwnClassForExam,
  findOwnSessionForHomework,
  findTeacherAssessment,
  resolveAssessmentTeacher,
  saveAssessmentDraft,
  sessionZone,
  type AssessmentWriteResult,
} from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone } from "@/lib/scheduling";
import {
  assessmentDeleteSchema,
  assessmentFormSchema,
  assessmentPayloadSchema,
  draftFromPayload,
  type AssessmentActionState,
} from "@/lib/validation/assessments";

/**
 * The builder's two writes (W2, D-W30). Each re-resolves the posted branch
 * through the actor's own relations (`teacherBranchContext` — never trusted,
 * U7), then asks `resolveAssessmentTeacher` for the owning teacher there: the
 * TEACHER experience, that branch's `assessment.manage.own` cell, an ACTIVE
 * TEACHER membership. Everything else — the class or session being the
 * teacher's own, the row being theirs, the limits — is the data layer's
 * (lib/db/assessments.ts). No centre action reaches any of it (D-W11).
 */

function refusal(result: Extract<AssessmentWriteResult, { ok: false }>): AssessmentActionState {
  if (result.error === "invalid") return { error: "invalid", draftErrors: result.errors };
  return { error: result.error };
}

function revalidateAssessmentPages(locale: string, ids: { assessmentId?: string; classGroupId?: string | null; sessionId?: string | null }) {
  revalidatePath(`/${locale}${ROUTES.teacherAssessments}`);
  if (ids.assessmentId) revalidatePath(`/${locale}${ROUTES.teacherAssessment(ids.assessmentId)}`);
  if (ids.classGroupId) revalidatePath(`/${locale}${ROUTES.teacherClass(ids.classGroupId)}`);
  if (ids.sessionId) revalidatePath(`/${locale}${ROUTES.teacherSession(ids.sessionId)}`);
}

/** "Save draft" — creates the draft on its first save, then updates it. */
export async function saveAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  // Every field here is hidden identity, not something the person typed: a
  // malformed post is answered as "not found", never as an invisible field error.
  const parsed = assessmentFormSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, centerId, assessmentId, type, classGroupId, sessionId } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return { error: "forbidden" };
  const teacher = await resolveAssessmentTeacher(prisma, ctx);
  if (!teacher) return { error: "forbidden" };

  let json: unknown;
  try {
    json = JSON.parse(parsed.data.payload);
  } catch {
    return { error: "invalid" };
  }
  const payload = assessmentPayloadSchema.safeParse(json);
  if (!payload.success) return { error: "invalid" };

  // Times are typed in the session's frozen timezone, else the branch's (D-14).
  const branchZone = centreTimeZone(ctx.settings);
  let zone = branchZone;
  let target: { classGroupId: string | null; sessionId: string | null };
  if (assessmentId) {
    const current = await findTeacherAssessment(prisma, teacher, assessmentId);
    if (!current) return { error: "notFound" };
    if (current.session) zone = sessionZone(current.session, branchZone);
    target = { classGroupId: current.classGroupId, sessionId: current.sessionId };
  } else if (type === "HOMEWORK") {
    const session = sessionId ? await findOwnSessionForHomework(prisma, teacher, sessionId) : null;
    if (!session) return { error: "notFound" };
    zone = sessionZone(session, branchZone);
    target = { classGroupId: session.classGroupId, sessionId: session.id };
  } else {
    const classGroup = classGroupId ? await findOwnClassForExam(prisma, teacher, classGroupId) : null;
    if (!classGroup) return { error: "notFound" };
    target = { classGroupId: classGroup.id, sessionId: null };
  }

  const { draft, badFields } = draftFromPayload(payload.data, zone);
  if (badFields.length > 0) {
    return { error: "invalid", fieldErrors: Object.fromEntries(badFields.map((field) => [field, "badTime"])) };
  }

  const actor = { userId: ctx.user.id };
  if (assessmentId) {
    const result = await saveAssessmentDraft(prisma, actor, teacher, assessmentId, draft);
    if (!result.ok) return refusal(result);
    revalidateAssessmentPages(locale, { assessmentId, ...target });
    return { status: "saved", savedAt: Date.now() };
  }

  const result =
    type === "HOMEWORK"
      ? await createAssessment(prisma, actor, teacher, { type, sessionId: target.sessionId!, draft })
      : await createAssessment(prisma, actor, teacher, { type, classGroupId: target.classGroupId!, draft });
  if (!result.ok) return refusal(result);
  revalidateAssessmentPages(locale, { assessmentId: result.id, ...target });
  redirect({ href: ROUTES.teacherAssessment(result.id), locale });
  return { status: "saved", savedAt: Date.now() };
}

/** Deletes a draft (confirmed in the UI), then lands on the list. */
export async function deleteAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  const parsed = assessmentDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, centerId, assessmentId } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return { error: "forbidden" };
  const teacher = await resolveAssessmentTeacher(prisma, ctx);
  if (!teacher) return { error: "forbidden" };

  const current = await findTeacherAssessment(prisma, teacher, assessmentId);
  if (!current) return { error: "notFound" };
  const result = await deleteAssessment(prisma, { userId: ctx.user.id }, teacher, assessmentId);
  if (!result.ok) return refusal(result);
  revalidateAssessmentPages(locale, { classGroupId: current.classGroupId, sessionId: current.sessionId });
  redirect({ href: ROUTES.teacherAssessments, locale });
  return { status: "deleted" };
}
