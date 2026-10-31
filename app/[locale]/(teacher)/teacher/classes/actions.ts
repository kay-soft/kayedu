"use server";

import { revalidatePath } from "next/cache";

import { ctxCan } from "@/lib/auth/tenant";
import { teacherBranchContext } from "@/lib/auth/teacher-scope";
import { isPairLinked } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import { classRequestSchema, type TeacherActionState } from "@/lib/validation/teacher";

/**
 * "Request a new class" (spec §4.2 item 4): writes a `ChangeRequest` at the
 * branch the form names (U7 — re-resolved here, its own grant and trust). Gated on `Membership.isTrustedTeacher` (M10,
 * closing the gap flagged at M7 — every active TEACHER membership was
 * treated as trusted until a manager could flip the flag off for one).
 *
 * This writes the request and lists the teacher's own — a manager reviews it
 * at `/approvals` (built as its own milestone after M8).
 */

const FORBIDDEN: TeacherActionState = { error: "forbidden" };
const NOT_TRUSTED: TeacherActionState = { error: "notTrusted" };

export async function createClassRequestAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const parsed = classRequestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, centerId, ...payload } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return { error: "forbidden" };
  if (!ctxCan(ctx, "changeRequest.create")) return FORBIDDEN;
  if (!(ctx.membership?.isTrustedTeacher ?? false)) return NOT_TRUSTED;
  const db = scoped(ctx);

  // A request names only entries this branch has picked and the platform
  // still offers — a deactivated one is no more requestable than it is
  // pickable (R8).
  if (payload.subjectId) {
    const subject = await db.subjects.findById(payload.subjectId);
    if (!subject || !subject.active || !subject.catalogActive) {
      return { fieldErrors: { subjectId: "notFound" } };
    }
  }
  if (payload.gradeId) {
    const grade = await db.grades.findById(payload.gradeId);
    if (!grade || !grade.active || !grade.catalogActive) {
      return { fieldErrors: { gradeId: "notFound" } };
    }
  }
  // U3: both picked and active here (above), and linked in the catalog.
  if (payload.subjectId && payload.gradeId && !(await isPairLinked(prisma, payload.gradeId, payload.subjectId))) {
    return { fieldErrors: { subjectId: "subjectNotInGrade" } };
  }

  await db.changeRequests.create({
    type: "NEW_CLASS",
    requestedBy: ctx.user.id,
    payload,
  });

  revalidatePath(`/${locale}${ROUTES.teacherClasses}`);
  return { status: "created" };
}
