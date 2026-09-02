"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import { classRequestSchema, type TeacherActionState } from "@/lib/validation/teacher";

/**
 * "Request a new class" (spec §4.2 item 4): writes a `ChangeRequest` at the
 * teacher's active center. Gated on `Membership.isTrustedTeacher` (M10,
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
  const ctx = await getTenantContext("teacher");
  if (!ctxCan(ctx, "changeRequest.create")) return FORBIDDEN;
  if (!(ctx.membership?.isTrustedTeacher ?? false)) return NOT_TRUSTED;
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
