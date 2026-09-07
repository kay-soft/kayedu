"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { teacherStudentProfileIds } from "@/lib/db/teacher-portal";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  sessionRequestSchema,
  teacherSessionDescriptionSchema,
  type TeacherActionState,
} from "@/lib/validation/teacher";
import type { TypeAheadResult } from "@/components/center/type-ahead-search";

/**
 * Session-description edit only (spec §4.2 item 2). Attendance and payments
 * stay a center-staff action (`app/[locale]/(center)/sessions/actions.ts`) —
 * the teacher portal is read-mostly for sessions.
 */

const NOT_FOUND: TeacherActionState = { error: "notFound" };
const EDIT_DEADLINE_PASSED: TeacherActionState = { error: "editDeadlinePassed" };

// ── Live type-ahead (M18, docs/04 §11.8) ────────────────────────────────────
// Narrowed to students this teacher has actually taught at the active
// center — never the center's full roster — exactly like the /teacher/
// students search. Selecting a result keeps the query in a "self-navigate"
// href back to this page: `filters.q` becomes the exact student code, which
// re-runs `teacherSessionListWhere`'s existing narrowing unchanged.
export async function searchOwnSessionStudentsTypeAheadAction(
  currentParams: string,
  query: string,
): Promise<TypeAheadResult[]> {
  const ctx = await getTenantContext("teacher");
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const studentIds = await teacherStudentProfileIds(prisma, ctx.center.id, ctx.user.id);
  if (studentIds.length === 0) return [];

  const rows = await scoped(ctx).students.search({
    where: { id: { in: studentIds }, ...studentSearchWhere(trimmed) },
    take: 8,
  });

  const kept = new URLSearchParams(currentParams);
  return rows.map((row) => {
    const params = new URLSearchParams(kept);
    params.set("q", row.studentCode);
    return {
      id: row.id,
      primary: fullName(localName(row, row.user)),
      secondary: row.studentCode,
      href: `${ROUTES.teacherSessions}?${params.toString()}`,
    };
  });
}

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
