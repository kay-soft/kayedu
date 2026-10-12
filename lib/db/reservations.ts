import type {
  BlockScope,
  ClassGroup,
  Enrollment,
  EnrollmentStatus,
  Prisma,
  PrismaClient,
  Reservation,
  User,
} from "@prisma/client";
// Relative imports on purpose — `npm run check:student-portal` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/teacher-portal.ts and lib/db/payments.ts).
import { claimStudentCode } from "./students.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";
import { cooldownUntil, enrollmentCap, isAtCapacity, isInCooldown } from "../capacity.ts";
import { classRoomSetFrom, ROOM_SET_SELECT } from "./room-sets.ts";

/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const TEACHER_SCOPE: BlockScope = "TEACHER";
const CLASS_SCOPE: BlockScope = "CLASS";
const ACTIVE_ENROLLMENT: EnrollmentStatus = "ACTIVE";
const EXISTING_ENROLLMENT_STATUSES: EnrollmentStatus[] = ["ACTIVE", "BLOCKED"];

/**
 * Reservation / enrollment writes for the student portal (M8, spec §5
 * "Reservations / enrollment"). Both functions take a `Prisma.TransactionClient`
 * — the caller wraps the call in `prisma.$transaction()`, exactly like
 * `lib/db/payments.ts`'s `recordPayment` — because claiming a student code and
 * writing the roster row must not leave a gap (docs/02-architecture.md §14).
 */

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * A student's identity is a global `User` (CLAUDE.md rule 4) — the same
 * person reserving at a center they have never touched before still needs a
 * center-local `StudentProfile` the moment they actually enroll (instant, or
 * on confirmation). This is the student-portal equivalent of `createPerson`/
 * `seedLocalName` (`lib/db/identity.ts`): there is no "match" step here since
 * the person *is* the authenticated caller, so their own `User` row seeds the
 * local record directly, exactly once, then it is independently editable at
 * that center like any other (docs/01-data-model.md §6).
 */
export async function ensureStudentProfile(
  tx: Prisma.TransactionClient,
  centerId: string,
  user: Pick<User, "id" | "firstName" | "lastName" | "email" | "phone" | "altPhone">,
) {
  const existing = await tx.studentProfile.findFirst({
    where: { userId: user.id, centerId },
  });
  if (existing) return existing;

  const studentCode = await claimStudentCode(tx, centerId);
  return tx.studentProfile.create({
    data: scopedData(centerId, {
      userId: user.id,
      studentCode,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      altPhone: user.altPhone,
    }),
  });
}

async function isBlockedFromClass(
  tx: Db,
  centerId: string,
  classGroup: Pick<ClassGroup, "id" | "teacherId">,
  studentUserId: string,
): Promise<boolean> {
  const [teacherBlocked, classBlocked] = await Promise.all([
    tx.studentBlock.count({
      where: scopedWhere(centerId, {
        scope: TEACHER_SCOPE,
        refId: classGroup.teacherId,
        blockedUserId: studentUserId,
      }),
    }),
    tx.studentBlock.count({
      where: scopedWhere(centerId, {
        scope: CLASS_SCOPE,
        refId: classGroup.id,
        blockedUserId: studentUserId,
      }),
    }),
  ]);
  return teacherBlocked > 0 || classBlocked > 0;
}

export type ReserveOrEnrollResult =
  | { ok: true; kind: "enrolled"; enrollmentId: string }
  | { ok: true; kind: "pending"; reservationId: string }
  | {
      ok: false;
      error:
        | "notFound"
        | "notAcceptingStudents"
        | "studentBlocked"
        | "alreadyEnrolled"
        | "alreadyRequested"
        | "classFull";
    }
  | { ok: false; error: "coolingOff"; cooldownUntil: Date };

/**
 * The student-facing write for Discover (spec §5, docs/04 §10): branches on
 * `ClassGroup.requiresConfirmation` exactly as the task requires — instant
 * enroll writes an ACTIVE `Enrollment` directly (no `Reservation` row at all,
 * `ReservationStatus` not applicable); confirmation-required writes a PENDING
 * `Reservation`. Blocking (both `StudentBlock` scopes) and duplicate
 * enrollment/reservation are re-checked here, never trusted from the client —
 * the same discipline as the center-staff `enrollStudentAction` (M4).
 *
 * Capacity is enforced immediately for the instant-enroll path (there is no
 * gatekeeper afterwards); for a confirmation-required class it is deliberately
 * **not** checked at request time — a center may legitimately want more
 * requests than seats so it can choose who to confirm — and is re-checked in
 * `confirmReservation` instead.
 *
 * `Reservation` is unique on `(classGroupId, studentId)` with no `centerId`/
 * `status` in that key (docs/01-data-model.md §2), so — like `Enrollment` —
 * the row is reused across its lifecycle rather than recreated: a student
 * whose earlier request was REJECTED/CANCELLED gets that same row reset to
 * PENDING rather than a second insert, which the unique constraint would
 * refuse anyway.
 */
export async function reserveOrEnroll(
  tx: Prisma.TransactionClient,
  params: { centerId: string; classGroupId: string; studentUserId: string },
): Promise<ReserveOrEnrollResult> {
  const { centerId, classGroupId, studentUserId } = params;

  const classGroup = await tx.classGroup.findFirst({
    where: scopedWhere(centerId, { id: classGroupId, active: true }),
    include: { room: ROOM_SET_SELECT.room, extraRooms: ROOM_SET_SELECT.extraRooms },
  });
  if (!classGroup) return { ok: false, error: "notFound" };
  if (!classGroup.acceptsNewStudents) return { ok: false, error: "notAcceptingStudents" };

  if (await isBlockedFromClass(tx, centerId, classGroup, studentUserId)) {
    return { ok: false, error: "studentBlocked" };
  }

  const existingProfile = await tx.studentProfile.findFirst({
    where: { userId: studentUserId, centerId },
  });
  if (existingProfile) {
    const existingEnrollment = await tx.enrollment.findFirst({
      where: scopedWhere(centerId, {
        classGroupId,
        studentProfileId: existingProfile.id,
        status: { in: EXISTING_ENROLLMENT_STATUSES },
      }),
    });
    if (existingEnrollment) return { ok: false, error: "alreadyEnrolled" };
  }

  const existingReservation = await tx.reservation.findFirst({
    where: scopedWhere(centerId, { classGroupId, studentId: studentUserId }),
  });
  if (existingReservation?.status === "PENDING") {
    return { ok: false, error: "alreadyRequested" };
  }
  if (existingReservation?.status === "CONFIRMED") {
    return { ok: false, error: "alreadyEnrolled" };
  }
  // A rejected student cannot re-request the same class for 7 days (M15,
  // spec §5.1 "Approvals & enrolment") — the reused row's own `rejectedAt` is
  // the whole mechanism (docs/01-data-model.md "Workflow layer"). Cancelling
  // your own pending request is not a rejection and carries no cooldown.
  if (
    existingReservation?.status === "REJECTED" &&
    existingReservation.rejectedAt &&
    isInCooldown(existingReservation.rejectedAt, new Date())
  ) {
    return { ok: false, error: "coolingOff", cooldownUntil: cooldownUntil(existingReservation.rejectedAt) };
  }

  if (!classGroup.requiresConfirmation) {
    // R3: the summed capacity of the class's room set — never a class field.
    const cap = enrollmentCap(classRoomSetFrom(classGroup).capacity);
    const active = await tx.enrollment.count({
      where: scopedWhere(centerId, { classGroupId, status: ACTIVE_ENROLLMENT }),
    });
    if (isAtCapacity(active, cap)) return { ok: false, error: "classFull" };

    const user = await tx.user.findUniqueOrThrow({ where: { id: studentUserId } });
    const profile = existingProfile ?? (await ensureStudentProfile(tx, centerId, user));
    const enrollment = await tx.enrollment.create({
      data: scopedData(centerId, {
        classGroupId,
        studentProfileId: profile.id,
        status: "ACTIVE",
      }),
    });
    return { ok: true, kind: "enrolled", enrollmentId: enrollment.id };
  }

  // A REJECTED/CANCELLED row from an earlier request is reused, never
  // recreated (the unique constraint would refuse a second insert anyway).
  const reservation = existingReservation
    ? await tx.reservation.update({
        where: { id: existingReservation.id },
        data: {
          status: "PENDING",
          requestedAt: new Date(),
          resolvedAt: null,
          resolvedBy: null,
          rejectedAt: null,
        },
      })
    : await tx.reservation.create({
        data: scopedData(centerId, { classGroupId, studentId: studentUserId, status: "PENDING" }),
      });

  return { ok: true, kind: "pending", reservationId: reservation.id };
}

export type ResolveReservationResult =
  | { ok: true; reservation: Reservation; enrollment?: Enrollment }
  | { ok: false; error: "notFound" | "notPending" | "studentBlocked" | "classFull" };

/**
 * Confirms a PENDING reservation into an ACTIVE enrollment. There is no
 * Approvals screen yet to call this from (docs/03-build-order.md M6/M7/M8
 * notes) — it is exercised directly by `npm run run check:student-portal`
 * today, production-ready for the Approvals screen a later milestone builds.
 * Re-checks blocking and capacity at confirm time (defensive: either could
 * have changed since the request was made).
 */
export async function confirmReservation(
  tx: Prisma.TransactionClient,
  centerId: string,
  reservationId: string,
  resolvedBy: string,
): Promise<ResolveReservationResult> {
  const reservation = await tx.reservation.findFirst({
    where: scopedWhere(centerId, { id: reservationId }),
  });
  if (!reservation) return { ok: false, error: "notFound" };
  if (reservation.status !== "PENDING") return { ok: false, error: "notPending" };

  // R4: a deactivated class takes no new students — its pending requests
  // wait (off both approvals queues) until it is reactivated.
  const classGroup = await tx.classGroup.findFirst({
    where: scopedWhere(centerId, { id: reservation.classGroupId, active: true }),
    include: { room: ROOM_SET_SELECT.room, extraRooms: ROOM_SET_SELECT.extraRooms },
  });
  if (!classGroup) return { ok: false, error: "notFound" };

  if (await isBlockedFromClass(tx, centerId, classGroup, reservation.studentId)) {
    return { ok: false, error: "studentBlocked" };
  }

  // Hard-capped by the class's room set (M15, revised R3 — spec §5.1
  // "Capacity") — staff cannot approve past the cap, request or no request.
  // Enrolments already above a reduced cap are never removed; only new ones
  // are refused.
  const cap = enrollmentCap(classRoomSetFrom(classGroup).capacity);
  const active = await tx.enrollment.count({
    where: scopedWhere(centerId, { classGroupId: classGroup.id, status: ACTIVE_ENROLLMENT }),
  });
  if (isAtCapacity(active, cap)) return { ok: false, error: "classFull" };

  const user = await tx.user.findUniqueOrThrow({ where: { id: reservation.studentId } });
  const profile = await ensureStudentProfile(tx, centerId, user);

  const existingEnrollment = await tx.enrollment.findFirst({
    where: scopedWhere(centerId, { classGroupId: classGroup.id, studentProfileId: profile.id }),
  });
  const enrollment = existingEnrollment
    ? await tx.enrollment.update({ where: { id: existingEnrollment.id }, data: { status: "ACTIVE" } })
    : await tx.enrollment.create({
        data: scopedData(centerId, {
          classGroupId: classGroup.id,
          studentProfileId: profile.id,
          status: "ACTIVE",
        }),
      });

  const updated = await tx.reservation.update({
    where: { id: reservation.id },
    data: { status: "CONFIRMED", resolvedAt: new Date(), resolvedBy },
  });

  return { ok: true, reservation: updated, enrollment };
}

export type RejectOrCancelResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; error: "notFound" | "notPending" };

/** Center/teacher-side decline. Same "no Approvals UI yet" note as above. */
export async function rejectReservation(
  db: Db,
  centerId: string,
  reservationId: string,
  resolvedBy: string,
): Promise<RejectOrCancelResult> {
  const reservation = await db.reservation.findFirst({
    where: scopedWhere(centerId, { id: reservationId }),
  });
  if (!reservation) return { ok: false, error: "notFound" };
  if (reservation.status !== "PENDING") return { ok: false, error: "notPending" };

  const now = new Date();
  const updated = await db.reservation.update({
    where: { id: reservation.id },
    // `rejectedAt` (M15) starts this (student, class) pair's 7-day
    // cooling-off — `reserveOrEnroll` reads it back off this same row.
    data: { status: "REJECTED", resolvedAt: now, resolvedBy, rejectedAt: now },
  });
  return { ok: true, reservation: updated };
}

/**
 * A student withdrawing their own PENDING request ("My reservations", spec
 * §4.3 item 3). Pinned to `studentId` as well as `centerId`, so a student can
 * never cancel another student's request even if they guess the id.
 */
export async function cancelReservation(
  db: Db,
  centerId: string,
  reservationId: string,
  studentUserId: string,
): Promise<RejectOrCancelResult> {
  const reservation = await db.reservation.findFirst({
    where: scopedWhere(centerId, { id: reservationId, studentId: studentUserId }),
  });
  if (!reservation) return { ok: false, error: "notFound" };
  if (reservation.status !== "PENDING") return { ok: false, error: "notPending" };

  const updated = await db.reservation.update({
    where: { id: reservation.id },
    data: { status: "CANCELLED", resolvedAt: new Date(), resolvedBy: studentUserId },
  });
  return { ok: true, reservation: updated };
}
