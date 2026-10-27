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
import { seedFromAccount } from "./account-study.ts";
import { claimStudentCode } from "./students.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";
import { ACCESSIBLE_LIFECYCLE_STATES } from "./platform.ts";
import { cooldownUntil, enrollmentCap, isAtCapacity, isInCooldown } from "../capacity.ts";
import { classRoomSetFrom, ROOM_SET_SELECT } from "./room-sets.ts";

/**
 * D-18 (SEC-2c, SEC-26): what one account may hold through the student
 * portal's self-service, across every centre. A real student holds a handful
 * of each; the caps exist so a few free accounts cannot squat every
 * instant-enrol seat or flood every centre's queue. Counted for the caller's
 * own identity only (identity-scoping, as `lib/db/student-portal.ts` reads a
 * student's own rows) and serialized per account, so parallel requests cannot
 * race past them. Staff enrolments are not limited by these.
 */
export const SELF_SERVICE_CAPS = {
  /** PENDING reservations at once — the 31st is refused until one resolves. */
  openReservations: 30,
  /** ACTIVE enrolments held when instant-enrolling — the 31st is refused. */
  activeEnrollments: 30,
} as const;

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
 *
 * **F4 — two-layer grade.** A *new* profile is also seeded from the student's
 * own account: `User.gradeId` (when this branch offers that grade) and the
 * parent they declared in F3's "Invite a parent". With both a grade and a
 * parent phone the profile is stamped complete and the one-time form is
 * skipped (D-11 unchanged — staff edits stay allowed). An existing profile is
 * returned untouched: the account never overwrites a branch's record.
 */
export async function ensureStudentProfile(
  tx: Prisma.TransactionClient,
  centerId: string,
  user: Pick<User, "id" | "firstName" | "lastName" | "email" | "phone" | "altPhone" | "gradeId">,
) {
  const existing = await tx.studentProfile.findFirst({
    where: { userId: user.id, centerId },
  });
  if (existing) return existing;

  const studentCode = await claimStudentCode(tx, centerId);
  const seeded = await seedFromAccount(tx, centerId, user);
  return tx.studentProfile.create({
    data: scopedData(centerId, {
      userId: user.id,
      studentCode,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      altPhone: user.altPhone,
      ...seeded,
    }),
  });
}

/** `SELECT … FOR UPDATE` on one class row, centre-scoped; false when not this centre's. */
export async function lockClassRow(
  tx: Prisma.TransactionClient,
  centerId: string,
  classGroupId: string,
): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ClassGroup" WHERE "id" = ${classGroupId} AND "centerId" = ${centerId} FOR UPDATE`;
  return locked.length > 0;
}

export type ClaimSeatResult =
  | { ok: true; enrollment: Enrollment }
  | { ok: false; error: "notFound" | "classFull" };

/**
 * The ONE place a class seat is taken (SEC-2b, SEC-13) — instant enrol
 * (`reserveOrEnroll`), a confirmed reservation (`confirmReservation`) and the
 * staff "Enrol" action all call it, inside their own transaction. The class
 * row is locked (`FOR UPDATE`, centre-scoped) **before** the active
 * enrolments are counted, and the count is a fresh statement after the lock —
 * so concurrent enrolments into one class serialize and the cap (the room
 * set's summed capacity, `lib/capacity.ts`) holds. A student who already has
 * this pair's enrolment row (removed earlier) gets it reactivated; otherwise
 * a new row is written. Blocking/duplicate checks stay with each caller.
 */
export async function claimClassSeat(
  tx: Prisma.TransactionClient,
  centerId: string,
  classGroupId: string,
  studentProfileId: string,
): Promise<ClaimSeatResult> {
  if (!(await lockClassRow(tx, centerId, classGroupId))) return { ok: false, error: "notFound" };
  const classGroup = await tx.classGroup.findFirst({
    where: scopedWhere(centerId, { id: classGroupId }),
    include: { room: ROOM_SET_SELECT.room, extraRooms: ROOM_SET_SELECT.extraRooms },
  });
  if (!classGroup) return { ok: false, error: "notFound" };

  const cap = enrollmentCap(classRoomSetFrom(classGroup).capacity);
  const active = await tx.enrollment.count({
    where: scopedWhere(centerId, { classGroupId, status: ACTIVE_ENROLLMENT }),
  });
  if (isAtCapacity(active, cap)) return { ok: false, error: "classFull" };

  // @@unique([studentProfileId, classGroupId]): a removed enrolment still
  // owns this pair's row — reactivate it rather than insert a second one.
  const existing = await tx.enrollment.findFirst({
    where: scopedWhere(centerId, { classGroupId, studentProfileId }),
  });
  const enrollment = existing
    ? await tx.enrollment.update({ where: { id: existing.id }, data: { status: ACTIVE_ENROLLMENT } })
    : await tx.enrollment.create({
        data: scopedData(centerId, { classGroupId, studentProfileId, status: ACTIVE_ENROLLMENT }),
      });
  return { ok: true, enrollment };
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
        | "classFull"
        | "reservationLimit"
        | "enrollmentLimit";
    }
  | { ok: false; error: "coolingOff"; cooldownUntil: Date };

/** One account's self-service writes run one at a time (D-18), so a cap is exact. */
async function lockSelfService(tx: Prisma.TransactionClient, studentUserId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`self-service:${studentUserId}`}, 0))`;
}

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

  // SEC-16: a SUSPENDED/ARCHIVED centre takes no reservation or enrolment by
  // direct call either — Discover's own filter is not the boundary.
  const classGroup = await tx.classGroup.findFirst({
    where: scopedWhere(centerId, {
      id: classGroupId,
      active: true,
      center: { lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } },
    }),
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
  // SEC-16: a student this centre deactivated cannot re-enrol themselves.
  if (existingProfile && !existingProfile.active) {
    return { ok: false, error: "studentBlocked" };
  }
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

  // D-18 (SEC-26): the per-account caps, after every per-class refusal so a
  // student at the cap still hears "already enrolled"/"already requested".
  await lockSelfService(tx, studentUserId);
  if (classGroup.requiresConfirmation) {
    const open = await tx.reservation.count({ where: { studentId: studentUserId, status: "PENDING" } });
    if (open >= SELF_SERVICE_CAPS.openReservations) return { ok: false, error: "reservationLimit" };
  } else {
    const active = await tx.enrollment.count({
      where: { status: ACTIVE_ENROLLMENT, studentProfile: { userId: studentUserId } },
    });
    if (active >= SELF_SERVICE_CAPS.activeEnrollments) return { ok: false, error: "enrollmentLimit" };
  }

  if (!classGroup.requiresConfirmation) {
    // R3: the summed capacity of the class's room set — never a class field.
    // SEC-13: counted under the class's row lock, taken before the profile is
    // made, so a profile is only ever created for a seat that is available.
    await lockClassRow(tx, centerId, classGroupId);
    const cap = enrollmentCap(classRoomSetFrom(classGroup).capacity);
    const peek = await tx.enrollment.count({
      where: scopedWhere(centerId, { classGroupId, status: ACTIVE_ENROLLMENT }),
    });
    if (isAtCapacity(peek, cap)) return { ok: false, error: "classFull" };

    const user = await tx.user.findUniqueOrThrow({ where: { id: studentUserId } });
    const profile = existingProfile ?? (await ensureStudentProfile(tx, centerId, user));
    const seat = await claimClassSeat(tx, centerId, classGroupId, profile.id);
    if (!seat.ok) return { ok: false, error: seat.error };
    return { ok: true, kind: "enrolled", enrollmentId: seat.enrollment.id };
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
  // are refused. SEC-13: counted under the class's row lock, before the
  // profile is made; the seat itself is `claimClassSeat`'s.
  await lockClassRow(tx, centerId, classGroup.id);
  const cap = enrollmentCap(classRoomSetFrom(classGroup).capacity);
  const active = await tx.enrollment.count({
    where: scopedWhere(centerId, { classGroupId: classGroup.id, status: ACTIVE_ENROLLMENT }),
  });
  if (isAtCapacity(active, cap)) return { ok: false, error: "classFull" };

  const user = await tx.user.findUniqueOrThrow({ where: { id: reservation.studentId } });
  const profile = await ensureStudentProfile(tx, centerId, user);

  const seat = await claimClassSeat(tx, centerId, classGroup.id, profile.id);
  if (!seat.ok) return { ok: false, error: seat.error };
  const enrollment = seat.enrollment;

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
