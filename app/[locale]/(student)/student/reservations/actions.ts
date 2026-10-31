"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { cancelReservation, leaveClass } from "@/lib/db/reservations";
import { runInTransaction } from "@/lib/db/session-lifecycle";
import { ROUTES } from "@/lib/routes";
import {
  cancelReservationSchema,
  leaveClassSchema,
  type StudentActionState,
} from "@/lib/validation/student";

const FORBIDDEN: StudentActionState = { error: "forbidden" };

/** A student withdrawing their own PENDING request (spec §4.3 item 3). */
export async function cancelReservationAction(
  _state: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = cancelReservationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, centerId, reservationId } = parsed.data;

  const result = await cancelReservation(prisma, centerId, reservationId, user.id);
  if (!result.ok) return { error: result.error };

  revalidatePath(`/${locale}${ROUTES.studentReservations}`);
  revalidatePath(`/${locale}${ROUTES.studentDiscover}`);

  return { status: "cancelled" };
}

/**
 * U8 — "Leave class": the student ending their own ACTIVE enrolment. The
 * client-sent `centerId` is never trusted on its own; `leaveClass` finds the
 * caller's own enrolment in that class at that branch, or it is "not found".
 * Parents have no such action: this resolves the signed-in user's own profile
 * only, so a parent's account (no profile of its own) always gets "not found".
 */
export async function leaveClassAction(
  _state: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = leaveClassSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, centerId, classGroupId } = parsed.data;

  const result = await runInTransaction(prisma, (tx) =>
    leaveClass(tx, { centerId, classGroupId, studentUserId: user.id }),
  );
  if (!result.ok) return { error: result.error };

  revalidatePath(`/${locale}${ROUTES.studentSchedule}`);
  revalidatePath(`/${locale}${ROUTES.studentCalendar}`);
  revalidatePath(`/${locale}${ROUTES.studentReservations}`);
  revalidatePath(`/${locale}${ROUTES.studentDiscover}`, "layout");
  return { status: "left" };
}
