"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  sessionRequestSchema,
  teacherSessionDescriptionSchema,
  type TeacherActionState,
} from "@/lib/validation/teacher";

/**
 * Session-description edit only (spec §4.2 item 2). Attendance and payments
 * stay a center-staff action (`app/[locale]/(center)/sessions/actions.ts`) —
 * the teacher portal is read-mostly for sessions.
 */

const NOT_FOUND: TeacherActionState = { error: "notFound" };
const EDIT_DEADLINE_PASSED: TeacherActionState = { error: "editDeadlinePassed" };

export async function updateSessionDescriptionAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const ctx = await getTenantContext("teacher");
  const db = scoped(ctx);

  const parsed = teacherSessionDescriptionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, sessionId, description } = parsed.data;

  const session = await db.sessions.findById(sessionId);
  if (!session || session.teacherId !== ctx.user.id) return NOT_FOUND;

  // The manager-set edit deadline (M10, closing the gap flagged at M5/M7):
  // null means no deadline, the original M7 behavior.
  const deadlineHours = ctx.settings?.teacherEditDeadlineHours ?? null;
  if (deadlineHours !== null) {
    const deadline = new Date(session.date);
    deadline.setUTCHours(deadline.getUTCHours() + deadlineHours);
    if (new Date() > deadline) return EDIT_DEADLINE_PASSED;
  }

  // Pinned to this teacher's own userId as well as the active center — a
  // session belonging to another teacher (even at the same center) matches
  // zero rows here, never gets edited.
  const result = await db.sessions.updateDescription(sessionId, ctx.user.id, description);
  if (result.count === 0) return NOT_FOUND;

  revalidatePath(`/${locale}${ROUTES.teacherSession(sessionId)}`);
  return { status: "saved" };
}

const FORBIDDEN: TeacherActionState = { error: "forbidden" };
const NOT_TRUSTED: TeacherActionState = { error: "notTrusted" };
const REQUEST_NOT_FOUND: TeacherActionState = { error: "notFound" };

/**
 * "Request new session" (spec §4.2 item 2): writes a `ChangeRequest` (type
 * `NEW_SESSION`, M10, closing the gap flagged since M7) for a one-off session
 * on one of the teacher's own classes at this center — free room/time is a
 * center manager's call at `/approvals`, same as the class request form.
 * Gated on `Membership.isTrustedTeacher` exactly like `createClassRequestAction`.
 */
export async function createSessionRequestAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const ctx = await getTenantContext("teacher");
  if (!ctxCan(ctx, "changeRequest.create")) return FORBIDDEN;
  if (!(ctx.membership?.isTrustedTeacher ?? false)) return NOT_TRUSTED;
  const db = scoped(ctx);

  const parsed = sessionRequestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, classGroupId, date, startTime, endTime, note } = parsed.data;

  // Only a class this teacher actually teaches at this center — never a
  // client-trusted classGroupId (docs/02 §7).
  const classGroup = await db.classGroups.findById(classGroupId);
  if (!classGroup || classGroup.teacherId !== ctx.user.id) return REQUEST_NOT_FOUND;

  await db.changeRequests.create({
    type: "NEW_SESSION",
    requestedBy: ctx.user.id,
    payload: { classGroupId, date, startTime, endTime, note },
  });

  revalidatePath(`/${locale}${ROUTES.teacherSessions}`);
  return { status: "created" };
}
