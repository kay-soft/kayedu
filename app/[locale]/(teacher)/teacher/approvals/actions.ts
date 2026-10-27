"use server";

import { revalidatePath } from "next/cache";

import { ctxCan, actionContext } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { confirmReservation, rejectReservation } from "@/lib/db/reservations";
import { cancelBookingByStaff, confirmBooking, rejectBooking } from "@/lib/db/session-bookings";
import { writeAuditLog } from "@/lib/db/audit";
import { formatDate } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import {
  approvalIdSchema,
  type ApprovalsActionState,
} from "@/lib/validation/approvals";
import { runInTransaction } from "@/lib/db/session-lifecycle";

/**
 * A teacher's own approvals queue (M15, spec §4.2 item 6): students
 * requesting to join *their* classes, accepted or rejected from the same
 * `Reservation` data the centre's own `/approvals` queue reads — no
 * parallel workflow, just a narrower view and a different reviewer.
 * `reservation.manage.own` gates the screen; the data-scoping check below
 * (the reservation's own class must belong to this teacher) is what stops a
 * teacher from acting on another teacher's request at the same centre, since
 * the permission alone only proves "some teacher may use this queue."
 */

const FORBIDDEN: ApprovalsActionState = { error: "forbidden" };
const NOT_FOUND: ApprovalsActionState = { error: "notFound" };

async function ownReservation(centerId: string, teacherId: string, reservationId: string) {
  return prisma.reservation.findFirst({
    where: { centerId, id: reservationId, classGroup: { teacherId } },
  });
}

function revalidateTeacherApprovals(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.teacherApprovals}`);
}

export async function approveOwnReservationAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await actionContext("teacher");
  if (!ctx) return { error: "forbidden" };
  if (!ctxCan(ctx, "reservation.manage.own")) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, id } = parsed.data;

  if (!(await ownReservation(ctx.center.id, ctx.user.id, id))) return NOT_FOUND;

  const result = await runInTransaction(prisma, (tx) =>
    confirmReservation(tx, ctx.center.id, id, ctx.user.id),
  );
  if (!result.ok) {
    if (result.error === "sessionFull") return { error: result.error, errorDate: formatDate(result.date, locale) };
    return { error: result.error };
  }

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "reservation.confirm",
    entityType: "Reservation",
    entityId: id,
    before: { status: "PENDING" },
    after: { status: "CONFIRMED", enrollmentId: result.enrollment?.id, via: "teacher" },
  });

  revalidateTeacherApprovals(locale);
  return { status: "approved" };
}

export async function declineOwnReservationAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await actionContext("teacher");
  if (!ctx) return { error: "forbidden" };
  if (!ctxCan(ctx, "reservation.manage.own")) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, id } = parsed.data;

  if (!(await ownReservation(ctx.center.id, ctx.user.id, id))) return NOT_FOUND;

  const result = await rejectReservation(prisma, ctx.center.id, id, ctx.user.id);
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "reservation.reject",
    entityType: "Reservation",
    entityId: id,
    before: { status: "PENDING" },
    after: { status: "REJECTED", via: "teacher" },
  });

  revalidateTeacherApprovals(locale);
  return { status: "declined" };
}

// ── Single-session bookings (F6) ────────────────────────────────────────────
// The same `reservation.manage.own` gate, and the same pin: the booking's
// session must belong to a class this teacher teaches — enforced inside the
// data layer's own lookup (`teacherId`), so another teacher's booking at the
// same branch is "not found".

export async function approveOwnBookingAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await actionContext("teacher");
  if (!ctx) return { error: "forbidden" };
  if (!ctxCan(ctx, "reservation.manage.own")) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, id } = parsed.data;

  const result = await runInTransaction(prisma, (tx) =>
    confirmBooking(tx, ctx.center.id, id, ctx.user.id, { teacherId: ctx.user.id, via: "teacher" }),
  );
  if (!result.ok) return { error: result.error };

  revalidateTeacherApprovals(locale);
  return { status: "approved" };
}

export async function declineOwnBookingAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await actionContext("teacher");
  if (!ctx) return { error: "forbidden" };
  if (!ctxCan(ctx, "reservation.manage.own")) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, id } = parsed.data;

  const result = await runInTransaction(prisma, (tx) =>
    rejectBooking(tx, ctx.center.id, id, ctx.user.id, { teacherId: ctx.user.id, via: "teacher" }),
  );
  if (!result.ok) return { error: result.error };

  revalidateTeacherApprovals(locale);
  return { status: "declined" };
}

/**
 * A teacher cancelling a confirmed booking on one of their own classes, from
 * their session page (T7). `reservation.manage.own`, pinned by `teacherId`
 * inside the data layer's own lookup — another teacher's booking at the same
 * branch is "not found". Same STAFF reason, seat release and audit row as the
 * branch's own cancel.
 */
export async function cancelOwnBookingAction(
  _state: ApprovalsActionState,
  formData: FormData,
): Promise<ApprovalsActionState> {
  const ctx = await actionContext("teacher");
  if (!ctx) return { error: "forbidden" };
  if (!ctxCan(ctx, "reservation.manage.own")) return FORBIDDEN;

  const parsed = approvalIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { locale, id } = parsed.data;

  const result = await runInTransaction(prisma, (tx) =>
    cancelBookingByStaff(tx, ctx.center.id, id, ctx.user.id, { teacherId: ctx.user.id, via: "teacher" }),
  );
  if (!result.ok) return { error: result.error };

  revalidateTeacherApprovals(locale);
  revalidatePath(`/${locale}${ROUTES.teacherSession(result.booking.sessionId)}`);
  return { status: "cancelled" };
}
