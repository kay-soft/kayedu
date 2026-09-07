"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { skipSessionRating, submitSessionRating } from "@/lib/db/ratings";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  skipSessionRatingSchema,
  submitSessionRatingSchema,
  type RatingActionState,
} from "@/lib/validation/ratings";

const FORBIDDEN: RatingActionState = { error: "forbidden" };

/**
 * The login pop-up's write path (M17, spec §5 "Teacher ratings"). Both
 * actions are identity-scoped off the signed-in `User` alone — a rating has
 * no single "active center" to resolve a `TenantContext` from (the pop-up
 * can list sessions attended at any centre this student has ever touched),
 * the same reasoning `app/[locale]/(student)/student/discover/actions.ts`
 * already documents for `reserveClassAction`.
 */
export async function submitSessionRatingAction(
  _state: RatingActionState,
  formData: FormData,
): Promise<RatingActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = submitSessionRatingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: Object.values(fieldErrorsFrom(parsed.error))[0] ?? "notFound" };
  }

  const result = await submitSessionRating(prisma, {
    studentUserId: user.id,
    sessionId: parsed.data.sessionId,
    score: parsed.data.score,
  });
  if (!result.ok) return { error: result.error };

  return { status: "rated" };
}

/**
 * Skipping must cost nothing (spec §5 "Teacher ratings"): this never fails
 * for a reason the student could act on, and it never re-surfaces the same
 * session — `skipSessionRating` persists the skip server-side, not in
 * browser storage, so it holds across devices and future logins too.
 */
export async function skipSessionRatingAction(
  _state: RatingActionState,
  formData: FormData,
): Promise<RatingActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = skipSessionRatingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: Object.values(fieldErrorsFrom(parsed.error))[0] ?? "notFound" };
  }

  await skipSessionRating(prisma, { studentUserId: user.id, sessionId: parsed.data.sessionId });
  return { status: "skipped" };
}
