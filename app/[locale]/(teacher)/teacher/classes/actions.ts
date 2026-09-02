"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import { classRequestSchema, type TeacherActionState } from "@/lib/validation/teacher";

/**
 * "Request a new class" (spec §4.2 item 4): writes a `ChangeRequest` at the
 * teacher's active center. There is no separate "trusted teacher" flag in
 * the schema (docs/01 §2) — every active TEACHER membership at a center is
 * treated as trusted for now, a flagged gap like the M5 edit-deadline note.
 *
 * This only writes the request and lists the teacher's own — the Approvals
 * screen that would review it is not built yet (docs/03 M6/M7 notes), a
 * deliberate scope boundary for this milestone.
 */

const FORBIDDEN: TeacherActionState = { error: "forbidden" };

export async function createClassRequestAction(
  _state: TeacherActionState,
  formData: FormData,
): Promise<TeacherActionState> {
  const ctx = await getTenantContext("teacher");
  if (!ctxCan(ctx, "changeRequest.create")) return FORBIDDEN;
  const db = scoped(ctx);

  const parsed = classRequestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { locale, ...payload } = parsed.data;

  await db.changeRequests.create({
    type: "NEW_CLASS",
    requestedBy: ctx.user.id,
    payload,
  });

  revalidatePath(`/${locale}${ROUTES.teacherClasses}`);
  return { status: "created" };
}
