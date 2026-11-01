"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { setTeacherHistoryDays } from "@/lib/db/account";
import { prisma } from "@/lib/db/client";
import { ROUTES } from "@/lib/routes";
import { teacherHistorySchema, type TeacherHistoryState } from "@/lib/validation/account";
import { fieldErrorsFrom } from "@/lib/validation/form";

/**
 * Account → "History shown in my teacher portal" (U6). The acting user is
 * always the session's, never a form field; a person with no teacher
 * membership is refused. It writes `User.teacherHistoryDays` only — the
 * teacher's own display preference, never a branch's window — so, like the
 * rest of the profile, no audit row.
 */
export async function saveTeacherHistoryAction(
  _state: TeacherHistoryState,
  formData: FormData,
): Promise<TeacherHistoryState> {
  const user = await getCurrentUser();
  if (!user) return { error: "failed" };

  const parsed = teacherHistorySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const result = await setTeacherHistoryDays(prisma, user.id, parsed.data.teacherHistoryDays);
  if (!result.ok) return { error: result.error };

  const { locale } = parsed.data;
  revalidatePath(`/${locale}${ROUTES.account}`);
  revalidatePath(`/${locale}/teacher`, "layout");
  return { status: "saved" };
}
