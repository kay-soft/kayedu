import type {
  EnrollmentStatus,
  Prisma,
  PrismaClient,
  SessionBooking,
  SessionBookingCancelReason,
  SessionBookingStatus,
} from "@prisma/client";
// Relative imports on purpose — `npm run check:student-portal`,
// `check:approvals` and `check:enrollment` exercise this module directly,
// outside the Next.js runtime (same reasoning as lib/db/reservations.ts).
import { bookingSeatError, bookingSeatStatus, enrollmentCap, type SeatStatus } from "../capacity.ts";
import { centreTimeZone, earliestTodayAnywhere, todayInTimezone } from "../scheduling.ts";
import { writeAuditRow } from "./audit-row.ts";
import { ACCESSIBLE_LIFECYCLE_STATES } from "./platform.ts";
import { ensureStudentProfile, isBlockedFromClass, lockClassRow, lockSelfService } from "./reservations.ts";
import { classRoomSetFrom, ROOM_SET_SELECT } from "./room-sets.ts";
import {
  BOOKABLE_SESSION,
  isBookableNow,
  lockSessionRow,
  sessionSeatUsage,
  sessionsSeatUsage,
} from "./session-seats.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";

/**
 * Single-session booking (F6, docs/00-master-product-spec.md §5.1
 * "Single-session booking"): a student who is not enrolled asks to attend one
 * session of a class. The **only** writer of `SessionBooking` rows (request,
 * confirm, reject, student cancel, staff cancel, cancel-with-session).
 *
 * - **Which classes:** `ClassGroup.sessionBookingMode` — OFF (no booking, the
 *   default and every pre-F6 class), INSTANT (CONFIRMED at once) or APPROVAL
 *   (PENDING in the branch's `/approvals` and the class teacher's own queue).
 * - **Which sessions:** a class session that is SCHEDULED, not closed,
 *   cancelled or rescheduled, and has not started in its own timezone.
 *   Booking closes at start time; a PENDING booking whose session has started
 *   reads as **expired** (nothing is written) and can no longer be confirmed.
 * - **Seats:** the class's seat limit (its room set); used = active
 *   enrolments + CONFIRMED bookings + walk-ins (`lib/capacity.ts`). Checked
 *   when a seat is taken — at request (INSTANT) and at confirm (APPROVAL) —
 *   under the class row lock and then the session row lock (the order every
 *   enrolment takes them), so two last-seat requests cannot both win.
 * - **Same checks as reservations:** accessible centre, active class that
 *   accepts new students, both `StudentBlock` scopes at request and at
 *   confirm, not enrolled, not already booked; at most
 *   `BOOKING_CAPS.openBookings` open bookings per account (serialized per
 *   account, D-18); no cooling-off.
 * - **Closing booking:** setting a class's mode to OFF stops new requests and
 *   the confirming of pending ones (`bookingOff`); bookings already CONFIRMED
 *   stand, and a pending one can still be rejected.
 * - **No money.** A booking records nothing financial; the student pays at
 *   the desk, where check-in links `sessionAttendeeId` (`createAttendance`).
 *   A booked no-show writes nothing.
 *
 * Every function takes `centerId` explicitly and scopes through it (rule 1);
 * the caller's transaction is used throughout, and the confirm/reject audit
 * rows commit with the change (`writeAuditRow(tx, …)`).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const BOOKING_CAPS = {
  /** PENDING + upcoming CONFIRMED bookings one account may hold, across every branch. */
  openBookings: 10,
} as const;

/** How many upcoming sessions a class page lists. */
export const UPCOMING_SESSIONS_SHOWN = 10;

const PENDING: SessionBookingStatus = "PENDING";
const CONFIRMED: SessionBookingStatus = "CONFIRMED";
const OPEN_STATUSES: SessionBookingStatus[] = ["PENDING", "CONFIRMED"];
const EXISTING_ENROLLMENT_STATUSES: EnrollmentStatus[] = ["ACTIVE", "BLOCKED"];

/** Everything a booking decision reads about its session and class. */
const SESSION_FOR_BOOKING = {
  id: true,
  classGroupId: true,
  status: true,
  closedAt: true,
  rescheduledToId: true,
  date: true,
  startTime: true,
  timezone: true,
  classGroup: {
    select: {
      id: true,
      teacherId: true,
      active: true,
      acceptsNewStudents: true,
      sessionBookingMode: true,
      maxBookingSeats: true,
      ...ROOM_SET_SELECT,
    },
  },
} satisfies Prisma.SessionSelect;

type SessionForBooking = Prisma.SessionGetPayload<{ select: typeof SESSION_FOR_BOOKING }>;
/** A booking's class — present on every bookable session; a one-time session has none and is never bookable. */
type ClassForBooking = NonNullable<SessionForBooking["classGroup"]>;

function loadSession(db: Db, centerId: string, sessionId: string, accessibleOnly: boolean) {
  return db.session.findFirst({
    where: scopedWhere(centerId, {
      id: sessionId,
      ...(accessibleOnly ? { center: { lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } } } : {}),
    }),
    select: SESSION_FOR_BOOKING,
  });
}

/** The student's existing enrolment or check-in here, if any — either means "don't book". */
async function enrolledOrCheckedIn(
  db: Db,
  centerId: string,
  session: { id: string; classGroupId: string | null },
  profileId: string,
): Promise<"alreadyEnrolled" | "alreadyCheckedIn" | null> {
  const [enrollment, attendee] = await Promise.all([
    session.classGroupId
      ? db.enrollment.findFirst({
          where: scopedWhere(centerId, {
            classGroupId: session.classGroupId,
            studentProfileId: profileId,
            status: { in: EXISTING_ENROLLMENT_STATUSES },
          }),
          select: { id: true },
        })
      : null,
    db.sessionAttendee.findFirst({
      where: scopedWhere(centerId, { sessionId: session.id, studentProfileId: profileId }),
      select: { id: true },
    }),
  ]);
  if (enrollment) return "alreadyEnrolled";
  if (attendee) return "alreadyCheckedIn";
  return null;
}

/**
 * One account's open bookings, across every branch (identity-scoped, like
 * D-18's caps): PENDING or CONFIRMED, not yet checked in, whose session has
 * not started. An expired PENDING one no longer counts.
 */
export async function openBookingCount(db: Db, studentUserId: string, now: Date): Promise<number> {
  const rows = await db.sessionBooking.findMany({
    where: {
      studentId: studentUserId,
      status: { in: OPEN_STATUSES },
      sessionAttendeeId: null,
      // Across every branch, so no one centre's day: a floor safe in any
      // frozen zone, then each row is judged exactly in its own.
      session: { ...BOOKABLE_SESSION, date: { gte: earliestTodayAnywhere(now) } },
    },
    select: {
      session: {
        select: {
          classGroupId: true,
          status: true,
          closedAt: true,
          rescheduledToId: true,
          date: true,
          startTime: true,
          timezone: true,
        },
      },
    },
  });
  return rows.filter((row) => isBookableNow(row.session, now)).length;
}

type SeatCheck = "sessionFull" | "bookingSeatsFull" | null;

/**
 * Take the locks a seat needs — the class row, then the session row, the
 * order enrolment takes them — and answer whether one more CONFIRMED booking
 * fits. Fresh counts after the locks.
 */
async function lockAndCheckSeat(
  tx: Prisma.TransactionClient,
  centerId: string,
  session: SessionForBooking,
  classGroup: ClassForBooking,
): Promise<SeatCheck> {
  await lockClassRow(tx, centerId, classGroup.id);
  await lockSessionRow(tx, centerId, session.id);
  const usage = await sessionSeatUsage(tx, centerId, session.id, classGroup.id);
  const cap = enrollmentCap(classRoomSetFrom(classGroup).capacity);
  return bookingSeatError(usage, cap, classGroup.maxBookingSeats);
}

// ── Request ─────────────────────────────────────────────────────────────────

export type RequestBookingError =
  | "notFound"
  | "notAcceptingStudents"
  | "bookingOff"
  | "sessionUnavailable"
  | "studentBlocked"
  | "alreadyEnrolled"
  | "alreadyCheckedIn"
  | "alreadyBooked"
  | "bookingLimit"
  | "sessionFull"
  | "bookingSeatsFull";

export type RequestBookingResult =
  | { ok: true; kind: "confirmed" | "pending"; booking: SessionBooking }
  | { ok: false; error: RequestBookingError };

/**
 * A student asks to attend one session (the student portal's "Attend this
 * session only"). INSTANT takes the seat now — the `StudentProfile` is made
 * only then, as instant enrolment does; APPROVAL writes a PENDING row and
 * leaves the seat check to `confirmBooking`. A cancelled or rejected row for
 * this (session, student) is reused, never a second insert.
 */
export async function requestBooking(
  tx: Prisma.TransactionClient,
  params: { centerId: string; sessionId: string; studentUserId: string; now?: Date },
): Promise<RequestBookingResult> {
  const { centerId, sessionId, studentUserId } = params;
  const now = params.now ?? new Date();

  const session = await loadSession(tx, centerId, sessionId, true);
  const classGroup = session?.classGroup;
  if (!session || !classGroup || !classGroup.active) return { ok: false, error: "notFound" };
  if (!classGroup.acceptsNewStudents) return { ok: false, error: "notAcceptingStudents" };
  if (classGroup.sessionBookingMode === "OFF") return { ok: false, error: "bookingOff" };
  if (!isBookableNow(session, now)) return { ok: false, error: "sessionUnavailable" };

  if (await isBlockedFromClass(tx, centerId, classGroup, studentUserId)) {
    return { ok: false, error: "studentBlocked" };
  }
  const profile = await tx.studentProfile.findFirst({
    where: { userId: studentUserId, centerId },
    select: { id: true, active: true },
  });
  // A student this branch deactivated cannot book themselves back in.
  if (profile && !profile.active) return { ok: false, error: "studentBlocked" };
  if (profile) {
    const already = await enrolledOrCheckedIn(tx, centerId, session, profile.id);
    if (already) return { ok: false, error: already };
  }

  const existing = await tx.sessionBooking.findFirst({
    where: scopedWhere(centerId, { sessionId, studentId: studentUserId }),
  });
  if (existing && OPEN_STATUSES.includes(existing.status)) return { ok: false, error: "alreadyBooked" };

  // The per-account cap, after every per-session refusal, serialized per
  // account with the same lock D-18's reservation caps use.
  await lockSelfService(tx, studentUserId);
  if ((await openBookingCount(tx, studentUserId, now)) >= BOOKING_CAPS.openBookings) {
    return { ok: false, error: "bookingLimit" };
  }

  const instant = classGroup.sessionBookingMode === "INSTANT";
  if (instant) {
    const seat = await lockAndCheckSeat(tx, centerId, session, classGroup);
    if (seat) return { ok: false, error: seat };
    const user = await tx.user.findUniqueOrThrow({ where: { id: studentUserId } });
    await ensureStudentProfile(tx, centerId, user);
  }

  const status = instant ? CONFIRMED : PENDING;
  const fields = {
    status,
    requestedAt: now,
    resolvedAt: instant ? now : null,
    resolvedBy: null,
    cancelledAt: null,
    cancelReason: null,
    sessionAttendeeId: null,
  };
  const booking = existing
    ? await tx.sessionBooking.update({ where: { id: existing.id }, data: fields })
    : await tx.sessionBooking.create({
        data: scopedData(centerId, { sessionId, studentId: studentUserId, ...fields }),
      });
  return { ok: true, kind: instant ? "confirmed" : "pending", booking };
}

// ── Resolve (the two approvals queues) ──────────────────────────────────────

export type ResolveBookingError =
  | "notFound"
  | "notPending"
  | "expired"
  | "bookingOff"
  | "studentBlocked"
  | "alreadyEnrolled"
  | "alreadyCheckedIn"
  | "sessionFull"
  | "bookingSeatsFull";

export type ResolveBookingResult =
  | { ok: true; booking: SessionBooking }
  | { ok: false; error: ResolveBookingError };

type ResolveOptions = {
  /** The teacher queue: the booking's class must be taught by this user. */
  teacherId?: string;
  /** "teacher" on the teacher queue — recorded in the audit row. */
  via?: "teacher";
  now?: Date;
};

async function loadPendingForResolve(
  tx: Prisma.TransactionClient,
  centerId: string,
  bookingId: string,
  options: ResolveOptions,
) {
  const booking = await tx.sessionBooking.findFirst({
    where: scopedWhere(centerId, {
      id: bookingId,
      ...(options.teacherId ? { session: { classGroup: { teacherId: options.teacherId } } } : {}),
    }),
  });
  if (!booking) return { ok: false as const, error: "notFound" as const };
  if (booking.status !== PENDING) return { ok: false as const, error: "notPending" as const };
  const session = await loadSession(tx, centerId, booking.sessionId, false);
  // A one-time session has no class and is never bookable (F6): "not found", never a crash.
  const classGroup = session?.classGroup;
  if (!session || !classGroup || !classGroup.active) return { ok: false as const, error: "notFound" as const };
  // Booking closes at start: a pending one is expired from then on, and
  // nothing is written for it — not even a rejection.
  if (!isBookableNow(session, options.now ?? new Date())) return { ok: false as const, error: "expired" as const };
  return { ok: true as const, booking, session, classGroup };
}

/**
 * Confirms a PENDING booking — the branch's `/approvals` (approvals.manage)
 * or the class teacher's own queue (reservation.manage.own, pinned by
 * `teacherId`). Refuses when the class's `sessionBookingMode` is OFF now
 * (`bookingOff`). Re-checks both blocks, enrolment, and the seats under the
 * locks; makes the `StudentProfile` only now. Audited `sessionBooking.confirm`
 * in the same transaction.
 */
export async function confirmBooking(
  tx: Prisma.TransactionClient,
  centerId: string,
  bookingId: string,
  resolvedBy: string,
  options: ResolveOptions = {},
): Promise<ResolveBookingResult> {
  const loaded = await loadPendingForResolve(tx, centerId, bookingId, options);
  if (!loaded.ok) return loaded;
  const { booking, session, classGroup } = loaded;

  // The branch closed single-session booking after this one was requested: a
  // pending booking can no longer be confirmed (it can still be rejected), and
  // already-CONFIRMED ones are untouched — this only guards the PENDING → CONFIRMED step.
  if (classGroup.sessionBookingMode === "OFF") return { ok: false, error: "bookingOff" };

  if (await isBlockedFromClass(tx, centerId, classGroup, booking.studentId)) {
    return { ok: false, error: "studentBlocked" };
  }
  const profile = await tx.studentProfile.findFirst({
    where: { userId: booking.studentId, centerId },
    select: { id: true, active: true },
  });
  if (profile && !profile.active) return { ok: false, error: "studentBlocked" };
  if (profile) {
    const already = await enrolledOrCheckedIn(tx, centerId, session, profile.id);
    if (already) return { ok: false, error: already };
  }

  const seat = await lockAndCheckSeat(tx, centerId, session, classGroup);
  if (seat) return { ok: false, error: seat };

  const user = await tx.user.findUniqueOrThrow({ where: { id: booking.studentId } });
  await ensureStudentProfile(tx, centerId, user);

  const now = options.now ?? new Date();
  // Conditional on still PENDING: a concurrent resolve of the same row loses.
  const updated = await tx.sessionBooking.updateMany({
    where: scopedWhere(centerId, { id: booking.id, status: PENDING }),
    data: { status: CONFIRMED, resolvedAt: now, resolvedBy },
  });
  if (updated.count === 0) return { ok: false, error: "notPending" };

  await writeAuditRow(tx, {
    centerId,
    actorUserId: resolvedBy,
    action: "sessionBooking.confirm",
    entityType: "SessionBooking",
    entityId: booking.id,
    before: { status: PENDING },
    after: { status: CONFIRMED, sessionId: booking.sessionId, ...(options.via ? { via: options.via } : {}) },
  });
  return { ok: true, booking: await tx.sessionBooking.findUniqueOrThrow({ where: { id: booking.id } }) };
}

/** Rejects a PENDING booking (no cooling-off). Audited `sessionBooking.reject`. */
export async function rejectBooking(
  tx: Prisma.TransactionClient,
  centerId: string,
  bookingId: string,
  resolvedBy: string,
  options: ResolveOptions = {},
): Promise<ResolveBookingResult> {
  const loaded = await loadPendingForResolve(tx, centerId, bookingId, options);
  if (!loaded.ok) return loaded;
  const { booking } = loaded;

  const updated = await tx.sessionBooking.updateMany({
    where: scopedWhere(centerId, { id: booking.id, status: PENDING }),
    data: { status: "REJECTED", resolvedAt: options.now ?? new Date(), resolvedBy },
  });
  if (updated.count === 0) return { ok: false, error: "notPending" };

  await writeAuditRow(tx, {
    centerId,
    actorUserId: resolvedBy,
    action: "sessionBooking.reject",
    entityType: "SessionBooking",
    entityId: booking.id,
    before: { status: PENDING },
    after: { status: "REJECTED", sessionId: booking.sessionId, ...(options.via ? { via: options.via } : {}) },
  });
  return { ok: true, booking: await tx.sessionBooking.findUniqueOrThrow({ where: { id: booking.id } }) };
}

// ── Cancel ──────────────────────────────────────────────────────────────────

export type CancelBookingResult =
  | { ok: true; booking: SessionBooking }
  | { ok: false; error: "notFound" | "notOpen" | "tooLate" };

/**
 * A student withdrawing their own PENDING or CONFIRMED booking, until the
 * session starts. Pinned to `studentId` as well as `centerId`, so a guessed
 * id of someone else's booking is "not found".
 */
export async function cancelBookingByStudent(
  db: Db,
  centerId: string,
  bookingId: string,
  studentUserId: string,
  now: Date = new Date(),
): Promise<CancelBookingResult> {
  const booking = await db.sessionBooking.findFirst({
    where: scopedWhere(centerId, { id: bookingId, studentId: studentUserId }),
    include: {
      session: {
        select: {
          classGroupId: true,
          status: true,
          closedAt: true,
          rescheduledToId: true,
          date: true,
          startTime: true,
          timezone: true,
        },
      },
    },
  });
  if (!booking) return { ok: false, error: "notFound" };
  if (!OPEN_STATUSES.includes(booking.status) || booking.sessionAttendeeId) return { ok: false, error: "notOpen" };
  if (!isBookableNow(booking.session, now)) return { ok: false, error: "tooLate" };

  const updated = await db.sessionBooking.updateMany({
    where: scopedWhere(centerId, { id: booking.id, status: { in: OPEN_STATUSES }, sessionAttendeeId: null }),
    data: { status: "CANCELLED", cancelledAt: now, cancelReason: "STUDENT" },
  });
  if (updated.count === 0) return { ok: false, error: "notOpen" };
  return { ok: true, booking: await db.sessionBooking.findUniqueOrThrow({ where: { id: booking.id } }) };
}

export type StaffCancelBookingResult =
  | { ok: true; booking: SessionBooking }
  | { ok: false; error: "notFound" | "notOpen" | "sessionClosed" };

/**
 * Staff cancelling a CONFIRMED booking that has not arrived — the session
 * page's "Booked — not arrived" list (T7). `cancelReason` STAFF; the seat is
 * freed by the same write (seats are derived from CONFIRMED bookings,
 * `lib/capacity.ts`), and the `sessionBooking.cancel` audit row (ids and
 * statuses only — D-20) commits in the caller's transaction.
 *
 * Gate: the caller checks `approvals.manage`, or — for a teacher —
 * `reservation.manage.own` and passes `teacherId`, which pins the booking to a
 * class that teacher teaches (another teacher's booking at the same branch is
 * "not found", exactly as on the approvals queues). A PENDING booking is
 * rejected, not cancelled; a booking already checked in, or on a closed
 * session, is history and refused. Unlike the student's own cancel there is no
 * "until the session starts" limit: a booked no-show can be cleared mid-session.
 */
export async function cancelBookingByStaff(
  tx: Prisma.TransactionClient,
  centerId: string,
  bookingId: string,
  cancelledBy: string,
  options: { teacherId?: string; via?: "teacher"; now?: Date } = {},
): Promise<StaffCancelBookingResult> {
  const booking = await tx.sessionBooking.findFirst({
    where: scopedWhere(centerId, {
      id: bookingId,
      ...(options.teacherId ? { session: { classGroup: { teacherId: options.teacherId } } } : {}),
    }),
    include: { session: { select: { closedAt: true } } },
  });
  if (!booking) return { ok: false, error: "notFound" };
  if (booking.status !== CONFIRMED || booking.sessionAttendeeId) return { ok: false, error: "notOpen" };
  if (booking.session.closedAt) return { ok: false, error: "sessionClosed" };

  const now = options.now ?? new Date();
  // Conditional on still CONFIRMED and not arrived: a check-in that links the
  // booking first wins, and this becomes "not open".
  const updated = await tx.sessionBooking.updateMany({
    where: scopedWhere(centerId, { id: booking.id, status: CONFIRMED, sessionAttendeeId: null }),
    data: { status: "CANCELLED", cancelledAt: now, cancelReason: "STAFF" },
  });
  if (updated.count === 0) return { ok: false, error: "notOpen" };

  await writeAuditRow(tx, {
    centerId,
    actorUserId: cancelledBy,
    action: "sessionBooking.cancel",
    entityType: "SessionBooking",
    entityId: booking.id,
    before: { status: CONFIRMED },
    after: {
      status: "CANCELLED",
      cancelReason: "STAFF",
      sessionId: booking.sessionId,
      ...(options.via ? { via: options.via } : {}),
    },
  });
  return { ok: true, booking: await tx.sessionBooking.findUniqueOrThrow({ where: { id: booking.id } }) };
}

/**
 * Cancelling or rescheduling a session cancels its open bookings, in the
 * caller's transaction (`cancelSession`, `rescheduleSession`). A booking the
 * student already checked in on stays as it is — it is history.
 */
export async function cancelSessionBookings(
  tx: Prisma.TransactionClient,
  centerId: string,
  sessionId: string,
  reason: Extract<SessionBookingCancelReason, "SESSION_CANCELLED" | "SESSION_RESCHEDULED">,
  now: Date = new Date(),
): Promise<number> {
  const result = await tx.sessionBooking.updateMany({
    where: scopedWhere(centerId, { sessionId, status: { in: OPEN_STATUSES }, sessionAttendeeId: null }),
    data: { status: "CANCELLED", cancelledAt: now, cancelReason: reason },
  });
  return result.count;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type UpcomingSession = {
  id: string;
  date: Date;
  startTime: string;
  endTime: string;
  seats: SeatStatus;
};

/**
 * A class page's "Upcoming sessions": the next sessions that can still be
 * booked (not started, in each session's own timezone), each with its seats
 * as a status — never a count. Scoped to one branch. The read starts at the
 * branch's own today, so already-past days never use up the page's rows.
 */
export async function upcomingBookableSessions(
  db: Db,
  centerId: string,
  classGroup: {
    id: string;
    maxBookingSeats: number | null;
    roomId: string | null;
    room: { id: string; name: string; capacity: number } | null;
    extraRooms: { room: { id: string; name: string; capacity: number } }[];
  },
  now: Date = new Date(),
): Promise<UpcomingSession[]> {
  const settings = await db.centerSettings.findUnique({ where: { centerId }, select: { timezone: true } });
  const rows = await db.session.findMany({
    where: scopedWhere(centerId, {
      ...BOOKABLE_SESSION,
      classGroupId: classGroup.id,
      date: { gte: todayInTimezone(centreTimeZone(settings), now) },
    }),
    select: {
      id: true,
      classGroupId: true,
      status: true,
      closedAt: true,
      rescheduledToId: true,
      date: true,
      startTime: true,
      endTime: true,
      timezone: true,
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    take: UPCOMING_SESSIONS_SHOWN + 4,
  });
  const upcoming = rows.filter((row) => isBookableNow(row, now)).slice(0, UPCOMING_SESSIONS_SHOWN);
  const usage = await sessionsSeatUsage(db, centerId, classGroup.id, upcoming.map((row) => row.id));
  const cap = enrollmentCap(classRoomSetFrom(classGroup).capacity);
  return upcoming.map((row) => ({
    id: row.id,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    seats: bookingSeatStatus(usage.get(row.id)!, cap, classGroup.maxBookingSeats),
  }));
}

/** This student's own bookings on the given sessions (status by session id). */
export async function studentBookingsBySession(
  db: Db,
  centerId: string,
  studentUserId: string,
  sessionIds: string[],
): Promise<Map<string, SessionBookingStatus>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db.sessionBooking.findMany({
    where: scopedWhere(centerId, { studentId: studentUserId, sessionId: { in: sessionIds } }),
    select: { sessionId: true, status: true },
  });
  return new Map(rows.map((row) => [row.sessionId, row.status]));
}

/** What a student-facing booking row reads as, given the clock. */
export type BookingDisplayStatus =
  | "PENDING"
  | "CONFIRMED"
  | "ATTENDED"
  | "EXPIRED"
  | "REJECTED"
  | "CANCELLED"
  | "CANCELLED_BY_BRANCH"
  | "MOVED";

export function bookingDisplayStatus(
  booking: {
    status: SessionBookingStatus;
    cancelReason: SessionBookingCancelReason | null;
    sessionAttendeeId: string | null;
    session: Parameters<typeof isBookableNow>[0];
  },
  now: Date,
): BookingDisplayStatus {
  if (booking.sessionAttendeeId) return "ATTENDED";
  if (booking.status === "CANCELLED") {
    if (booking.cancelReason === "SESSION_RESCHEDULED") return "MOVED";
    return booking.cancelReason === "STAFF" ? "CANCELLED_BY_BRANCH" : "CANCELLED";
  }
  if (booking.status === "REJECTED") return "REJECTED";
  // An open booking whose session started: a pending one expired; a
  // confirmed one simply happened (a no-show writes nothing).
  if (booking.status === "PENDING" && !isBookableNow(booking.session, now)) return "EXPIRED";
  return booking.status;
}
