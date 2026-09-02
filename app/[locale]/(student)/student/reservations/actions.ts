"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { cancelReservation } from "@/lib/db/reservations";
import { ROUTES } from "@/lib/routes";
import {
  cancelReservationSchema,
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
