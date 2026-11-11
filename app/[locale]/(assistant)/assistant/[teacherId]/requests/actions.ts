"use server";

import { revalidatePath } from "next/cache";

import { assistantActionScope, findAtBranches, scopeBranches } from "@/lib/auth/assistant-context";
import { fileRequestOnBehalf } from "@/lib/db/assistant-requests";
import { isPairLinked } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { scopedWhere } from "@/lib/db/tenant-scope";
import { ROUTES } from "@/lib/routes";
import { assistantTeacherRefSchema } from "@/lib/validation/assistants";
import { fieldErrorsFrom } from "@/lib/validation/form";
import { classRequestSchema, sessionRequestSchema, type TeacherActionState } from "@/lib/validation/teacher";

/**
 * Requests an assistant files for the teacher (W7b, D-W37 item 5) — the
 * teacher's own two, `NEW_SESSION` and `NEW_CLASS`, with the teacher's forms
 * and validation. The teacher comes from the route segment and is re-resolved
 * with the session's user (`assistantActionScope`); `requests.manage` must be
 * granted where it is filed (`assistantCan`: the grant, the teacher's
 * `changeRequest.create` cell, their trusted flag, the branch setting). A
 * session request's branch comes from **the class**, never the posted
 * `centerId`; a class request's named branch is accepted only if it is one of
 * those. `fileRequestOnBehalf` re-checks it all in its transaction and stores
 * the request as the teacher's, "via assistant", audited with both people.
 */

const FORBIDDEN: TeacherActionState = { error: "forbidden" };
const NOT_FOUND: TeacherActionState = { error: "notFound" };

export async function assistantCreateSessionRequestAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  if (!who.success) return NOT_FOUND;
  const parsed = sessionRequestSchema.safeParse(entries);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { teacherId } = who.data;
  const { locale, classGroupId, date, startTime, endTime, note } = parsed.data;

  const scope = await assistantActionScope(teacherId);
  if (!scope) return FORBIDDEN;
  const hit = await findAtBranches(scopeBranches(scope, "requests.manage"), (branch) =>
    prisma.classGroup.findFirst({ where: scopedWhere(branch.centerId, { id: classGroupId, teacherId }), select: { id: true } }),
  );
  if (!hit) return NOT_FOUND;

  const result = await fileRequestOnBehalf(prisma, {
    assistantUserId: scope.user.id,
    teacherUserId: teacherId,
    centerId: hit.branch.centerId,
    request: { type: "NEW_SESSION", payload: { classGroupId: hit.found.id, date, startTime, endTime, note } },
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/${locale}${ROUTES.assistantRequests(teacherId)}`);
  return { status: "created" };
}

export async function assistantCreateClassRequestAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const entries = Object.fromEntries(formData);
  const who = assistantTeacherRefSchema.safeParse(entries);
  if (!who.success) return NOT_FOUND;
  const parsed = classRequestSchema.safeParse(entries);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { teacherId } = who.data;
  const { locale, centerId, ...payload } = parsed.data;

  const scope = await assistantActionScope(teacherId);
  if (!scope) return FORBIDDEN;
  // A class request has no row to take its branch from: the named branch is
  // only accepted when it is one the assistant may file at for this teacher.
  const branch = scopeBranches(scope, "requests.manage").find((entry) => entry.centerId === centerId);
  if (!branch) return FORBIDDEN;
  const db = scoped(branch.ctx);

  // The teacher's own catalog rules (R8, U3): picked here, still offered, linked.
  if (payload.subjectId) {
    const subject = await db.subjects.findById(payload.subjectId);
    if (!subject || !subject.active || !subject.catalogActive) return { fieldErrors: { subjectId: "notFound" } };
  }
  if (payload.gradeId) {
    const grade = await db.grades.findById(payload.gradeId);
    if (!grade || !grade.active || !grade.catalogActive) return { fieldErrors: { gradeId: "notFound" } };
  }
  if (payload.subjectId && payload.gradeId && !(await isPairLinked(prisma, payload.gradeId, payload.subjectId))) {
    return { fieldErrors: { subjectId: "subjectNotInGrade" } };
  }

  const result = await fileRequestOnBehalf(prisma, {
    assistantUserId: scope.user.id,
    teacherUserId: teacherId,
    centerId: branch.centerId,
    request: { type: "NEW_CLASS", payload },
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/${locale}${ROUTES.assistantRequests(teacherId)}`);
  return { status: "created" };
}
