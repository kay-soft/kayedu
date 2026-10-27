"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { setAccountGrade } from "@/lib/db/account-study";
import { prisma } from "@/lib/db/client";
import { ROUTES } from "@/lib/routes";
import { studyDetailsSchema } from "@/lib/validation/account";
import { fieldErrorsFrom } from "@/lib/validation/form";

/** `error` and the `fieldErrors` values are keys under `Account.errors`. */
export type StudyDetailsState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "saved";
};

export const IDLE_STUDY_STATE: StudyDetailsState = {};

/**
 * Sets the caller's own account grade (F4) — from onboarding's "Your studies"
 * and Account → Study details. The acting user is always the session's, never
 * a form field. It writes `User.gradeId` and nothing else: no branch record,
 * no enrolment (`lib/db/account-study.ts`). Not sensitive money/permission
 * data, so no audit row — the same as the rest of the profile.
 */
export async function saveStudyDetailsAction(
  _state: StudyDetailsState,
  formData: FormData,
): Promise<StudyDetailsState> {
  const user = await getCurrentUser();
  if (!user) return { error: "failed" };

  const parsed = studyDetailsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const result = await setAccountGrade(prisma, user.id, parsed.data.gradeId);
  if (!result.ok) return { fieldErrors: { gradeId: "failed" } };

  const { locale } = parsed.data;
  revalidatePath(`/${locale}${ROUTES.account}`);
  revalidatePath(`/${locale}${ROUTES.studentDiscover}`);
  return { status: "saved" };
}
