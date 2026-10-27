import type { AttendanceStatus, EnrollmentStatus, Prisma, PrismaClient, SessionBookingStatus } from "@prisma/client";
// Relative imports on purpose — `npm run check:enrollment` and
// `check:student-portal` exercise this module directly, outside Next.
import { enrolmentOverflowsSession, type SessionSeatUsage } from "../capacity.ts";
import { DEFAULT_TIMEZONE, addDays, hasSessionStarted, startOfUtcDay } from "../scheduling.ts";
import { scopedWhere } from "./tenant-scope.ts";

/**
 * Who holds a seat in one session (F6, docs/00 §5.1 "Single-session
 * booking"). Read by the booking writes (`lib/db/session-bookings.ts`), by
 * enrolment (`claimClassSeat` — an enrolment takes a seat in every future
 * session) and by the student's class page. Kept apart from both writers so
 * neither imports the other. Every read is `centerId`-scoped (rule 1).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const CONFIRMED: SessionBookingStatus = "CONFIRMED";
const ACTIVE: EnrollmentStatus = "ACTIVE";
const PRESENT_OR_LATE: AttendanceStatus[] = ["PRESENT", "LATE"];

/**
 * A session that can still take a booking: a class session, SCHEDULED, not
 * closed, cancelled or rescheduled. "Not started yet" is a clock rule on top
 * (`isBookableNow`), in the session's own frozen timezone.
 */
export const BOOKABLE_SESSION = {
  classGroupId: { not: null },
  status: "SCHEDULED",
  closedAt: null,
  rescheduledToId: null,
} satisfies Prisma.SessionWhereInput;

export function isBookableNow(
  session: {
    classGroupId: string | null;
    status: string;
    closedAt: Date | null;
    rescheduledToId: string | null;
    date: Date;
    startTime: string;
    timezone: string | null;
  },
  now: Date,
): boolean {
  return (
    session.classGroupId !== null &&
    session.status === "SCHEDULED" &&
    session.closedAt === null &&
    session.rescheduledToId === null &&
    !hasSessionStarted(session, now, session.timezone ?? DEFAULT_TIMEZONE)
  );
}

/**
 * `SELECT … FOR UPDATE` on one session row, centre-scoped — every booking
 * that takes a seat, and every enrolment that checks this session, holds it,
 * so two last-seat requests serialize and the second one counts the first.
 */
export async function lockSessionRow(
  tx: Prisma.TransactionClient,
  centerId: string,
  sessionId: string,
): Promise<boolean> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Session" WHERE "id" = ${sessionId} AND "centerId" = ${centerId} FOR UPDATE`;
  return locked.length > 0;
}

/** Walk-ins: drop-ins checked in Present/Late with no booking behind them. */
function walkInWhere(centerId: string, sessionIds: string[]): Prisma.SessionAttendeeWhereInput {
  return scopedWhere(centerId, {
    sessionId: { in: sessionIds },
    isDropIn: true,
    attendanceStatus: { in: PRESENT_OR_LATE },
    booking: { is: null },
  });
}

/** One session's seat usage — fresh statements, so a caller holding the row lock reads the truth. */
export async function sessionSeatUsage(
  db: Db,
  centerId: string,
  sessionId: string,
  classGroupId: string,
): Promise<SessionSeatUsage> {
  const [activeEnrollments, confirmedBookings, walkIns] = await Promise.all([
    db.enrollment.count({ where: scopedWhere(centerId, { classGroupId, status: ACTIVE }) }),
    db.sessionBooking.count({ where: scopedWhere(centerId, { sessionId, status: CONFIRMED }) }),
    db.sessionAttendee.count({ where: walkInWhere(centerId, [sessionId]) }),
  ]);
  return { activeEnrollments, confirmedBookings, walkIns };
}

/** The same usage for several sessions of one class, batched (the class page). */
export async function sessionsSeatUsage(
  db: Db,
  centerId: string,
  classGroupId: string,
  sessionIds: string[],
): Promise<Map<string, SessionSeatUsage>> {
  if (sessionIds.length === 0) return new Map();
  const [activeEnrollments, bookings, walkIns] = await Promise.all([
    db.enrollment.count({ where: scopedWhere(centerId, { classGroupId, status: ACTIVE }) }),
    db.sessionBooking.groupBy({
      by: ["sessionId"],
      where: scopedWhere(centerId, { sessionId: { in: sessionIds }, status: CONFIRMED }),
      _count: { _all: true },
    }),
    db.sessionAttendee.groupBy({
      by: ["sessionId"],
      where: walkInWhere(centerId, sessionIds),
      _count: { _all: true },
    }),
  ]);
  const bookingsBy = new Map(bookings.map((row) => [row.sessionId, row._count._all]));
  const walkInsBy = new Map(walkIns.map((row) => [row.sessionId, row._count._all]));
  return new Map(
    sessionIds.map((id) => [
      id,
      { activeEnrollments, confirmedBookings: bookingsBy.get(id) ?? 0, walkIns: walkInsBy.get(id) ?? 0 },
    ]),
  );
}

/**
 * Enrolment against the future (F6): the first not-yet-started open session
 * of the class that one more enrolment would overflow, counting the class's
 * active enrolments and **that session's** CONFIRMED bookings — or null.
 * The enrolling student's own bookings are not counted against them (their
 * seat is already one of those). Only sessions holding a confirmed booking can
 * overflow beyond the class's own cap, so only those are read. Each one found
 * is re-read under its row lock before it refuses, so a booking racing the
 * enrolment is seen.
 */
export async function firstOverflowingSession(
  tx: Prisma.TransactionClient,
  params: {
    centerId: string;
    classGroupId: string;
    cap: number;
    activeEnrollments: number;
    studentUserId: string;
    now?: Date;
  },
): Promise<{ sessionId: string; date: Date } | null> {
  const { centerId, classGroupId, cap, activeEnrollments, studentUserId } = params;
  if (cap <= 0) return null;
  const now = params.now ?? new Date();

  const sessions = await tx.session.findMany({
    where: scopedWhere(centerId, {
      ...BOOKABLE_SESSION,
      classGroupId,
      // A day of slack either side of UTC; the clock rule below is exact.
      date: { gte: addDays(startOfUtcDay(now), -1) },
      bookings: { some: { status: CONFIRMED } },
    }),
    select: {
      id: true,
      classGroupId: true,
      status: true,
      closedAt: true,
      rescheduledToId: true,
      date: true,
      startTime: true,
      timezone: true,
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  for (const session of sessions) {
    if (!isBookableNow(session, now)) continue;
    await lockSessionRow(tx, centerId, session.id);
    const others = await tx.sessionBooking.count({
      where: scopedWhere(centerId, { sessionId: session.id, status: CONFIRMED, studentId: { not: studentUserId } }),
    });
    if (enrolmentOverflowsSession(activeEnrollments, others, cap)) {
      return { sessionId: session.id, date: session.date };
    }
  }
  return null;
}
