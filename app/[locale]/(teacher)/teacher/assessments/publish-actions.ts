"use server";

import { revalidatePath } from "next/cache";

import { teacherBranchContext } from "@/lib/auth/teacher-scope";
import {
  extendAssessment,
  findTeacherAssessment,
  publishAssessment,
  resolveAssessmentTeacher,
  sessionZone,
  unpublishAssessment,
} from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone } from "@/lib/scheduling";
import {
  assessmentExtendSchema,
  assessmentPublishSchema,
  instantFromFields,
  type AssessmentActionState,
} from "@/lib/validation/assessments";

/**
 * Publish, unpublish and extend (W3a, D-W01, D-W08, D-W31). Same guards as the
 * builder's actions: the posted branch is re-resolved through the actor's own
 * relations (U7), then `resolveAssessmentTeacher` asks for the owning teacher
 * there. The rules are the data layer's (lib/db/assessments.ts).
 */

function revalidateRow(locale: string, row: { id: string; classGroupId: string; sessionId: string | null }) {
  revalidatePath(`/${locale}${ROUTES.teacherAssessments}`);
  revalidatePath(`/${locale}${ROUTES.teacherAssessment(row.id)}`);
  revalidatePath(`/${locale}${ROUTES.teacherClass(row.classGroupId)}`);
  if (row.sessionId) revalidatePath(`/${locale}${ROUTES.teacherSession(row.sessionId)}`);
}

/** DRAFT → PUBLISHED, refused unless "Ready to publish" is all done. */
export async function publishAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  const parsed = assessmentPublishSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, centerId, assessmentId } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return { error: "forbidden" };
  const teacher = await resolveAssessmentTeacher(prisma, ctx);
  if (!teacher) return { error: "forbidden" };

  const current = await findTeacherAssessment(prisma, teacher, assessmentId);
  if (!current) return { error: "notFound" };
  const result = await publishAssessment(prisma, { userId: ctx.user.id }, teacher, assessmentId, new Date());
  if (!result.ok) return { error: result.error };
  revalidateRow(locale, current);
  return { status: "published" };
}

/** PUBLISHED → DRAFT, only while no student has started. */
export async function unpublishAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  const parsed = assessmentPublishSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, centerId, assessmentId } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return { error: "forbidden" };
  const teacher = await resolveAssessmentTeacher(prisma, ctx);
  if (!teacher) return { error: "forbidden" };

  const current = await findTeacherAssessment(prisma, teacher, assessmentId);
  if (!current) return { error: "notFound" };
  const result = await unpublishAssessment(prisma, { userId: ctx.user.id }, teacher, assessmentId);
  if (!result.ok) return { error: result.error };
  revalidateRow(locale, current);
  return { status: "unpublished" };
}

/** A later closing time or deadline, typed in the session's frozen timezone, else the branch's. */
export async function extendAssessmentAction(
  _state: AssessmentActionState,
  formData: FormData,
): Promise<AssessmentActionState> {
  const parsed = assessmentExtendSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, centerId, assessmentId, date, time } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return { error: "forbidden" };
  const teacher = await resolveAssessmentTeacher(prisma, ctx);
  if (!teacher) return { error: "forbidden" };

  const current = await findTeacherAssessment(prisma, teacher, assessmentId);
  if (!current) return { error: "notFound" };
  const branchZone = centreTimeZone(ctx.settings);
  const zone = current.session ? sessionZone(current.session, branchZone) : branchZone;
  const newEnd = instantFromFields({ date, time }, zone);
  if (newEnd === null || newEnd === "invalid") return { error: "badTime" };

  const result = await extendAssessment(prisma, { userId: ctx.user.id }, teacher, assessmentId, newEnd, new Date());
  if (!result.ok) return { error: result.error };
  revalidateRow(locale, current);
  return { status: "extended" };
}
