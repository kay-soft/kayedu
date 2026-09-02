"use server";

import { revalidatePath } from "next/cache";

import { getTenantContext } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  teacherSessionDescriptionSchema,
  type TeacherActionState,
} from "@/lib/validation/teacher";

/**
 * Session-description edit only (spec §4.2 item 2). Attendance and payments
 * stay a center-staff action (`app/[locale]/(center)/sessions/actions.ts`) —
 * the teacher portal is read-mostly for sessions.
 */

const NOT_FOUND: TeacherActionState = { error: "notFound" };

export async function updateSessionDescriptionAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const ctx = await getTenantContext("teacher");
  const db = scoped(ctx);

  const parsed = teacherSessionDescriptionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, sessionId, description } = parsed.data;

  // Pinned to this teacher's own userId as well as the active center — a
  // session belonging to another teacher (even at the same center) matches
  // zero rows here, never gets edited.
  const result = await db.sessions.updateDescription(sessionId, ctx.user.id, description);
  if (result.count === 0) return NOT_FOUND;

  revalidatePath(`/${locale}${ROUTES.teacherSession(sessionId)}`);
  return { status: "saved" };
}
