import type { EnrollmentStatus, Prisma, PrismaClient, SessionBookingStatus, SessionStatus } from "@prisma/client";
// Relative imports on purpose — `npm run check:student-portal` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/teacher-portal.ts and lib/db/discover.ts).
import { EXCLUDE_DROP_IN_NO_SHOWS, attendanceDisplay } from "../attendance-rules.ts";
import { CATALOG_OVERRIDE_SELECT, type CatalogNameOverride } from "../catalog.ts";
import { DEFAULT_TIMEZONE, addDays, earliestTodayAnywhere, todayInTimezone } from "../scheduling.ts";
import { ACCESSIBLE_CENTER } from "./platform.ts";
import { BOOKABLE_SESSION, isBookableNow } from "./session-seats.ts";
import { NOT_MOVED_SESSION } from "./slot-conflicts.ts";
import { scopedWhere } from "./tenant-scope.ts";
import type { SessionLabelSource } from "../session-label.ts";

/** Typed so a spread into a Prisma `where` keeps the enum, not `string`. */
const CANCELLED_STATUS: SessionStatus = "CANCELLED";
const ACTIVE_ENROLLMENT: EnrollmentStatus = "ACTIVE";

/**
 * Cross-center read helpers for the student's own data (M8, mirroring
 * `lib/db/teacher-portal.ts`'s doc-comment almost exactly): a student's
 * blocks, reservations and enrollments legitimately span every center they
 * have ever touched — including a center where a `Reservation` exists but no
 * `StudentProfile` has been created yet (a PENDING request before it is
 * confirmed). That is a different shape than the teacher portal's "one
 * `TenantContext` per center, unioned by the caller": there is no per-center
 * context to loop over here until a `StudentProfile` exists, so these three
 * lookups are filtered by `studentUserId` — the caller's own, server-resolved
 * identity — directly, exactly like `lib/auth/tenant.ts`'s
 * `getUserCenterRelations` already does for `Membership`/`StudentProfile`.
 * That is identity-scoping, not a missing center scope: it can only ever
 * return rows that belong to this one person, across however many centers,
 * never another student's data (docs/02-architecture.md §5).
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Every block against this student, grouped by the center it was placed at. */
export async function studentBlockedRefsByCenter(
  db: Db,
  studentUserId: string,
): Promise<Map<string, { teacherIds: Set<string>; classGroupIds: Set<string> }>> {
  const rows = await db.studentBlock.findMany({ where: { blockedUserId: studentUserId } });

  const byCenter = new Map<string, { teacherIds: Set<string>; classGroupIds: Set<string> }>();
  for (const row of rows) {
    const entry = byCenter.get(row.centerId) ?? { teacherIds: new Set(), classGroupIds: new Set() };
    if (row.scope === "TEACHER") entry.teacherIds.add(row.refId);
    else entry.classGroupIds.add(row.refId);
    byCenter.set(row.centerId, entry);
  }
  return byCenter;
}

/** This student's reservation status per class, across every center. */
export async function studentReservationStatusByClass(
  db: Db,
  studentUserId: string,
): Promise<Map<string, "PENDING" | "CONFIRMED" | "REJECTED" | "CANCELLED">> {
  const rows = await db.reservation.findMany({
    where: { studentId: studentUserId },
    select: { classGroupId: true, status: true },
  });
  return new Map(rows.map((row) => [row.classGroupId, row.status]));
}

/** Every class this student is actively enrolled in, across every center. */
export async function studentActiveEnrollmentClassIds(
  db: Db,
  studentUserId: string,
): Promise<Set<string>> {
  const rows = await db.enrollment.findMany({
    where: { status: "ACTIVE", studentProfile: { userId: studentUserId } },
    select: { classGroupId: true },
  });
  return new Set(rows.map((row) => row.classGroupId));
}

/**
 * "My reservations" (spec §4.3): every request this student has ever made.
 *
 * This is the one catalog-display read in this module that genuinely can't
 * push a `selections: { where: { centerId } }` filter into the query itself
 * (M13): it's identity-scoped across every centre the student ever
 * reserved at, so there is no single `centerId` to filter the nested
 * include by. Instead it batch-resolves the distinct (centre, catalog id)
 * pairs actually present in the result — one extra query, not one per row —
 * and attaches a `selections` array to each subject/grade matching the same
 * shape a single-centre nested include would have produced, so
 * `lib/catalog.ts`'s `catalogLabelWithSelection` reads it back identically.
 */
export async function listReservationsForStudent(db: Db, studentUserId: string) {
  const rows = await db.reservation.findMany({
    // U5: a branch a platform admin deleted takes its requests with it.
    where: { studentId: studentUserId, center: { deletedAt: null } },
    orderBy: { requestedAt: "desc" },
    include: {
      center: { select: { id: true, name: true, logoPath: true, themeColor: true } },
      classGroup: { select: CROSS_CENTRE_CLASS_LABEL_SELECT },
    },
  });
  const labelled = await withCentreCatalogNames(db, rows.map((row) => row.classGroup));
  return rows.map((row, index) => ({ ...row, classGroup: labelled[index] }));
}

/** A class's catalog labels as an identity-scoped (cross-centre) read selects them. */
const CROSS_CENTRE_CLASS_LABEL_SELECT = {
  id: true,
  centerId: true,
  subjectId: true,
  gradeId: true,
  subject: { select: { nameAr: true, nameEn: true } },
  grade: { select: { nameAr: true, nameEn: true } },
} satisfies Prisma.ClassGroupSelect;

type CrossCentreClassLabel = Prisma.ClassGroupGetPayload<{ select: typeof CROSS_CENTRE_CLASS_LABEL_SELECT }>;

/**
 * The centre-local display names for classes read across centres (M13): one
 * batched query over the distinct (centre, catalog id) pairs present, attached
 * as a `selections` array in the shape a single-centre nested include has, so
 * `lib/catalog.ts`'s `catalogLabelWithSelection` reads it back identically.
 */
async function withCentreCatalogNames(db: Db, classes: CrossCentreClassLabel[]) {
  type Pair = { kind: "SUBJECT" | "GRADE"; centerId: string; catalogId: string };
  const pairsByKey = new Map<string, Pair>();
  for (const row of classes) {
    if (row.subjectId) {
      const pair: Pair = { kind: "SUBJECT", centerId: row.centerId, catalogId: row.subjectId };
      pairsByKey.set(`${pair.kind}:${pair.centerId}:${pair.catalogId}`, pair);
    }
    if (row.gradeId) {
      const pair: Pair = { kind: "GRADE", centerId: row.centerId, catalogId: row.gradeId };
      pairsByKey.set(`${pair.kind}:${pair.centerId}:${pair.catalogId}`, pair);
    }
  }
  const pairs = [...pairsByKey.values()];

  const selections = pairs.length
    ? await db.centerCatalogSelection.findMany({
        where: {
          OR: pairs.map((pair) =>
            pair.kind === "SUBJECT"
              ? { kind: "SUBJECT" as const, centerId: pair.centerId, subjectId: pair.catalogId }
              : { kind: "GRADE" as const, centerId: pair.centerId, gradeId: pair.catalogId },
          ),
        },
        select: { centerId: true, kind: true, subjectId: true, gradeId: true, ...CATALOG_OVERRIDE_SELECT },
      })
    : [];

  const overrideByKey = new Map<string, CatalogNameOverride>();
  for (const selection of selections) {
    const catalogId = selection.kind === "SUBJECT" ? selection.subjectId : selection.gradeId;
    if (catalogId) {
      overrideByKey.set(`${selection.kind}:${selection.centerId}:${catalogId}`, {
        displayNameAr: selection.displayNameAr,
        displayNameEn: selection.displayNameEn,
      });
    }
  }

  const withDisplayName = (
    kind: "SUBJECT" | "GRADE",
    centerId: string,
    catalogId: string | null,
  ): CatalogNameOverride[] => {
    const override = catalogId ? overrideByKey.get(`${kind}:${centerId}:${catalogId}`) : undefined;
    return [override ?? { displayNameAr: null, displayNameEn: null }];
  };

  return classes.map((row) => ({
    ...row,
    subject: row.subject
      ? { ...row.subject, selections: withDisplayName("SUBJECT", row.centerId, row.subjectId) }
      : null,
    grade: row.grade
      ? { ...row.grade, selections: withDisplayName("GRADE", row.centerId, row.gradeId) }
      : null,
  }));
}

/**
 * "My requests → Session bookings" (F6): every single-session booking this
 * student has made, across every branch — read by their own `studentId`,
 * like the reservations above. Carries the replacement session's date for one
 * a reschedule cancelled ("moved to <date> — book again").
 */
export async function listBookingsForStudent(db: Db, studentUserId: string) {
  const rows = await db.sessionBooking.findMany({
    where: { studentId: studentUserId, center: { deletedAt: null } },
    orderBy: { requestedAt: "desc" },
    take: 100,
    select: {
      id: true,
      centerId: true,
      status: true,
      cancelReason: true,
      requestedAt: true,
      sessionAttendeeId: true,
      center: { select: { id: true, name: true, nameEn: true } },
      session: {
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
          rescheduledTo: { select: { date: true, startTime: true } },
          classGroup: { select: CROSS_CENTRE_CLASS_LABEL_SELECT },
        },
      },
    },
  });
  const classes = rows.flatMap((row) => (row.session.classGroup ? [row.session.classGroup] : []));
  const labelled = new Map((await withCentreCatalogNames(db, classes)).map((row) => [row.id, row]));
  return rows.map((row) => ({
    ...row,
    session: {
      ...row.session,
      classGroup: row.session.classGroup ? labelled.get(row.session.classGroup.id)! : null,
    },
  }));
}

// ── Schedule: one center's slice, unioned by the caller (getStudentContexts) ─

/**
 * Fields a schedule card renders — never a full include. A function of
 * `centerId`, not a static object (M13): `subject`/`grade` each carry a
 * nested, centre-scoped `selections` lookup so a student sees this centre's
 * own rename when it has one.
 */
function studentUpcomingSessionInclude(centerId: string) {
  const withSelection = { include: { selections: { where: { centerId } } } } as const;
  return {
    classGroup: { include: { subject: withSelection, grade: withSelection, room: true } },
    // R5 — a one-time session's own subject/grade (no class).
    subject: withSelection,
    grade: withSelection,
    room: true,
    // U2 — "Moved from <date, time>" on a replacement.
    rescheduledFrom: { select: { date: true, startTime: true } },
  } satisfies Prisma.SessionInclude;
}

/**
 * Every future, non-cancelled session for this student's active enrollments
 * at one center. R4: never a deactivated class's — its enrolments stay
 * ACTIVE so reactivating restores it, but it is off every forward-looking
 * list meanwhile.
 *
 * U7: the calendar reads one month — `toDate` bounds it, and
 * `includeCancelled` keeps that month's cancelled sessions (shown struck
 * through). Every other rule is the schedule's own.
 */
export function studentUpcomingSessions(
  db: Db,
  centerId: string,
  studentProfileId: string,
  fromDate: Date,
  options: { toDate?: Date; includeCancelled?: boolean } = {},
) {
  return db.session.findMany({
    where: scopedWhere(centerId, {
      date: options.toDate ? { gte: fromDate, lte: options.toDate } : { gte: fromDate },
      ...(options.includeCancelled ? {} : { status: { not: CANCELLED_STATUS } }),
      // U2 — a session rescheduled away is off the schedule; its replacement is on it.
      ...NOT_MOVED_SESSION,
      classGroup: { active: true, enrollments: { some: { studentProfileId, status: ACTIVE_ENROLLMENT } } },
    }),
    include: studentUpcomingSessionInclude(centerId),
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    take: 100,
  });
}

/** A booking that still holds (or asks for) a seat — the only ones a schedule shows. */
const SCHEDULE_BOOKING_STATUSES: SessionBookingStatus[] = ["PENDING", "CONFIRMED"];

export type BookedUpcomingSession = {
  bookingId: string;
  /** CONFIRMED reads "Booked", PENDING reads "Requested". */
  bookingStatus: "PENDING" | "CONFIRMED";
  centerId: string;
  centerName: string;
  session: Prisma.SessionGetPayload<{ include: ReturnType<typeof studentUpcomingSessionInclude> }>;
};

/**
 * F6 follow-up (T7): the upcoming sessions a student has **booked** (single
 * session, not enrolled) — read-only, no write path. A CONFIRMED booking is
 * "Booked"; a PENDING one is "Requested" for as long as its session can still
 * be booked (once it has started it reads as expired and drops out, as on My
 * requests). Cancelled, rejected, expired, moved (rescheduled) and cancelled
 * sessions never appear, and neither does a closed session.
 *
 * `bookingWhere` is the one place a caller scopes the read: the student's own
 * id (identity-scoped, like `listBookingsForStudent` — a PENDING booking can
 * sit at a branch where no `StudentProfile` exists yet) or one branch's child
 * (`childBookedUpcoming`). Each branch's session rows are then fetched with
 * that branch's own `centerId` filter and its own catalog renames.
 */
async function bookedUpcoming(
  db: Db,
  bookingWhere: Prisma.SessionBookingWhereInput,
  now: Date,
): Promise<BookedUpcomingSession[]> {
  const rows = await db.sessionBooking.findMany({
    where: {
      ...bookingWhere,
      status: { in: SCHEDULE_BOOKING_STATUSES },
      center: ACCESSIBLE_CENTER,
      // Bookings across branches: a floor safe in any frozen zone; each row
      // is then judged in its own session's zone below.
      session: { ...BOOKABLE_SESSION, date: { gte: earliestTodayAnywhere(now) } },
    },
    orderBy: [{ session: { date: "asc" } }, { session: { startTime: "asc" } }],
    take: 100,
    select: {
      id: true,
      centerId: true,
      status: true,
      center: { select: { name: true } },
      session: {
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
      },
    },
  });

  const shown = rows.filter((row) =>
    row.status === "PENDING"
      ? isBookableNow(row.session, now)
      : row.session.date.getTime() >= todayInTimezone(row.session.timezone ?? DEFAULT_TIMEZONE, now).getTime(),
  );

  const idsByCenter = new Map<string, string[]>();
  for (const row of shown) idsByCenter.set(row.centerId, [...(idsByCenter.get(row.centerId) ?? []), row.session.id]);
  const sessions = new Map<string, Awaited<ReturnType<typeof loadBookedSessions>>[number]>();
  for (const [centerId, ids] of idsByCenter) {
    for (const session of await loadBookedSessions(db, centerId, ids)) sessions.set(session.id, session);
  }

  return shown.flatMap((row) => {
    const session = sessions.get(row.session.id);
    return session
      ? [{ bookingId: row.id, bookingStatus: row.status as "PENDING" | "CONFIRMED", centerId: row.centerId, centerName: row.center.name, session }]
      : [];
  });
}

function loadBookedSessions(db: Db, centerId: string, sessionIds: string[]) {
  return db.session.findMany({
    where: scopedWhere(centerId, { id: { in: sessionIds } }),
    include: studentUpcomingSessionInclude(centerId),
  });
}

/** Every upcoming session this student has booked or requested, across every branch. */
export function studentBookedUpcoming(db: Db, studentUserId: string, now: Date = new Date()) {
  return bookedUpcoming(db, { studentId: studentUserId }, now);
}

/** The same read for one child at one branch — the parent portal's mirror. */
export function childBookedUpcoming(db: Db, centerId: string, studentProfileId: string, now: Date = new Date()) {
  return bookedUpcoming(
    db,
    scopedWhere(centerId, { student: { studentProfiles: { some: { id: studentProfileId, centerId } } } }),
    now,
  );
}

/**
 * Past attendance for this student at one center — read from `SessionAttendee`
 * rather than the enrollment's schedule, because "past" must show what
 * actually happened (attended/absent/paid), not just what was scheduled.
 * Covers drop-in sessions too, since a `SessionAttendee` row exists for those
 * as well (docs/01 §1 principle 4).
 */
export function studentPastAttendance(
  db: Db,
  centerId: string,
  studentProfileId: string,
  uptoDate: Date,
  // U7: the calendar's month start — a bounded read of the same rows.
  options: { fromDate?: Date } = {},
) {
  const withSelection = { include: { selections: { where: { centerId } } } } as const;
  return db.sessionAttendee.findMany({
    where: scopedWhere(centerId, {
      studentProfileId,
      session: { date: options.fromDate ? { gte: options.fromDate, lt: uptoDate } : { lt: uptoDate } },
      // T5 — a drop-in's ABSENT row is a "never really came" record, not a
      // past session (lib/attendance-rules.ts).
      ...EXCLUDE_DROP_IN_NO_SHOWS,
    }),
    include: {
      session: {
        include: {
          classGroup: { include: { subject: withSelection, grade: withSelection } },
          // R5 — a one-time session's own subject/grade (no class).
          subject: withSelection,
          grade: withSelection,
          room: true,
        },
      },
      payments: { where: { voided: false }, orderBy: { recordedAt: "desc" }, take: 1 },
    },
    orderBy: { session: { date: "desc" } },
    take: 100,
  });
}

// ── Calendar (U7): one branch's month, from the schedule's own reads ────────

export type StudentCalendarStatus = "PRESENT" | "LATE" | "ABSENT" | "UPCOMING" | "BOOKED" | "REQUESTED" | "CANCELLED";

export type StudentCalendarEntry = {
  sessionId: string;
  centerId: string;
  date: Date;
  startTime: string;
  endTime: string;
  status: StudentCalendarStatus;
  /** The session as `sessionLabelParts` reads it. */
  session: SessionLabelSource;
  roomName: string | null;
};

type CalendarSessionRow = SessionLabelSource & {
  id: string;
  date: Date;
  startTime: string;
  endTime: string;
  room: { name: string } | null;
  classGroup: (SessionLabelSource["classGroup"] & { room?: { name: string } | null }) | null;
};

/**
 * One branch's month for a student's (or, through the parent portal, a
 * child's) calendar — built only from the schedule's own reads and rules:
 * - an enrolled session from the branch's `today` on is **Upcoming**, and a
 *   cancelled one in the month is **Cancelled** (`studentUpcomingSessions`,
 *   bounded to the month, cancelled kept);
 * - what happened is the attendance row (`studentPastAttendance`, bounded):
 *   **Present / Late / Absent** — `attendanceDisplay` with the session's own
 *   closed state, so a live session's "not arrived" stays Upcoming for an
 *   enrolled student and a drop-in who never came (T5) shows nothing;
 * - a moved original (U2) never appears — both reads already leave it out
 *   or it is skipped here — and a cancelled session never reads as attended.
 * Single sessions booked or requested are the caller's (`studentBookedUpcoming`
 * / `childBookedUpcoming`): an enrolled session wins over a booking.
 */
export async function studentCalendarMonth(
  db: Db,
  centerId: string,
  studentProfileId: string,
  range: { start: Date; end: Date },
  today: Date,
): Promise<StudentCalendarEntry[]> {
  const [enrolled, attended] = await Promise.all([
    studentUpcomingSessions(db, centerId, studentProfileId, range.start, { toDate: range.end, includeCancelled: true }),
    studentPastAttendance(db, centerId, studentProfileId, addDays(range.end, 1), { fromDate: range.start }),
  ]);

  const bySession = new Map<string, StudentCalendarEntry>();
  const entry = (session: CalendarSessionRow, status: StudentCalendarStatus): StudentCalendarEntry => ({
    sessionId: session.id,
    centerId,
    date: session.date,
    startTime: session.startTime,
    endTime: session.endTime,
    status,
    session,
    roomName: session.room?.name ?? session.classGroup?.room?.name ?? null,
  });

  for (const session of enrolled) {
    if (session.status === CANCELLED_STATUS) bySession.set(session.id, entry(session, "CANCELLED"));
    else if (session.date.getTime() >= today.getTime()) bySession.set(session.id, entry(session, "UPCOMING"));
  }
  for (const row of attended) {
    if (row.session.rescheduledToId !== null || row.session.status === CANCELLED_STATUS) continue;
    const shown = attendanceDisplay(row, row.session.closedAt !== null);
    if (shown === "NOT_ARRIVED") continue;
    bySession.set(row.session.id, entry(row.session, shown));
  }
  return [...bySession.values()];
}

/** A booked or requested single session as a calendar entry — unless the student is enrolled in it. */
export function bookedCalendarEntries(
  booked: BookedUpcomingSession[],
  range: { start: Date; end: Date },
  enrolledSessionIds: Set<string>,
): StudentCalendarEntry[] {
  return booked
    .filter(
      (entry) =>
        !enrolledSessionIds.has(entry.session.id) &&
        entry.session.date.getTime() >= range.start.getTime() &&
        entry.session.date.getTime() <= range.end.getTime(),
    )
    .map((entry) => ({
      sessionId: entry.session.id,
      centerId: entry.centerId,
      date: entry.session.date,
      startTime: entry.session.startTime,
      endTime: entry.session.endTime,
      status: entry.bookingStatus === "CONFIRMED" ? "BOOKED" : "REQUESTED",
      session: entry.session,
      roomName: entry.session.room?.name ?? entry.session.classGroup?.room?.name ?? null,
    }));
}
