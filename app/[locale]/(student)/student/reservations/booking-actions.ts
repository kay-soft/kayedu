"use server";

import { revalidatePath } from "next/cache";

import { clientIp } from "@/lib/auth/request-ip";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { cancelBookingByStudent, requestBooking } from "@/lib/db/session-bookings";
import { runInTransaction } from "@/lib/db/session-lifecycle";
import { checkRateLimits } from "@/lib/rate-limit";
import { ROUTES } from "@/lib/routes";
import {
  bookSessionSchema,
  cancelBookingSchema,
  type StudentActionState,
} from "@/lib/validation/student";

const FORBIDDEN: StudentActionState = { error: "forbidden" };

function revalidateStudent(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.studentReservations}`);
  revalidatePath(`/${locale}${ROUTES.studentDiscover}`, "layout");
  revalidatePath(`/${locale}${ROUTES.studentSchedule}`);
}

/**
 * "Attend this session only" (F6, spec §4.3). Like the Discover reserve
 * action, the client-sent `centerId` is never trusted on its own:
 * `requestBooking` re-derives the session inside that branch, so a mismatched
 * pair is "not found". The D-18 self-service rate limit applies (per account
 * and per IP, the same buckets as reserving); the 10-open-bookings cap lives
 * in the data layer.
 */
export async function bookSessionAction(
  _state: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = bookSessionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, centerId, sessionId } = parsed.data;

  const allowed = await checkRateLimits([
    { name: "selfServicePerUser", key: user.id },
    { name: "selfServicePerIp", key: await clientIp() },
  ]);
  if (!allowed) return { error: "rateLimited" };

  const result = await runInTransaction(prisma, (tx) =>
    requestBooking(tx, { centerId, sessionId, studentUserId: user.id }),
  );
  if (!result.ok) return { error: result.error };

  revalidateStudent(locale);
  return { status: result.kind === "confirmed" ? "booked" : "bookingPending" };
}

/** A student cancelling their own PENDING or CONFIRMED booking, until the session starts. */
export async function cancelBookingAction(
  _state: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  const user = await getCurrentUser();
  if (!user) return FORBIDDEN;

  const parsed = cancelBookingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, centerId, bookingId } = parsed.data;

  const result = await cancelBookingByStudent(prisma, centerId, bookingId, user.id);
  if (!result.ok) return { error: result.error };

  revalidateStudent(locale);
  return { status: "cancelled" };
}
