import type { Prisma, PrismaClient, SessionStatus } from "@prisma/client";

// Relative imports on purpose — `npm run check:teacher-portal` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/analytics.ts and lib/db/sessions.ts).
import { EXCLUDE_DROP_IN_NO_SHOWS } from "../attendance-rules.ts";
import { centreTimeZone, monthRangeUtc, todayInTimezone, weekRangeUtc } from "../scheduling.ts";
import { type DateRange, revenueTotals } from "./analytics.ts";
import { teacherHistoryFloor } from "./visibility.ts";
import { NOT_MOVED_SESSION, OPEN_CLASS_SESSION } from "./slot-conflicts.ts";
import { scopedWhere } from "./tenant-scope.ts";
import { likeSearchToken } from "../like.ts";

/** Typed so a spread into a Prisma `where` keeps the enum, not `string` (matches lib/db/sessions.ts). */
const CANCELLED_STATUS: SessionStatus = "CANCELLED";

/**
 * Cross-center read helpers for the teacher portal (M7, docs/01-data-model.md
 * §4 "Teacher cross-center visibility"). Every function here still takes one
 * `centerId` and reads through the same `scopedWhere` primitive every other
 * tenant-scoped query uses — there is no query in this file that spans more
 * than one center. A combined, multi-center view is built by the *caller*
 * running one of these per center (via `getTeacherContexts`, one
 * `TenantContext` per center a teacher belongs to) and unioning the results
 * in memory, never by widening a `where` clause across centers.
 */

type Db = PrismaClient | Prisma.TransactionClient;

// ── History preference (U6) ─────────────────────────────────────────────────

/**
 * The teacher portal's own history floor (U6, docs/01 §7): the oldest session
 * date this teacher's portal shows at this branch, from their own
 * `User.teacherHistoryDays` counted back from the branch's today — `null`
 * (all history) at 0, the default. No centre window is ever applied in the
 * teacher portal; this is the teacher's preference alone. Applied to the
 * portal's reads (dashboard, session list, students, student history,
 * session detail) — never to a write's integrity check, and never to
 * settlements (carved out).
 */
export function teacherPortalHistoryFloor(
  ctx: { user: { teacherHistoryDays: number }; settings: { timezone: string } | null },
  now: Date = new Date(),
): Date | null {
  return teacherHistoryFloor(ctx.user.teacherHistoryDays, centreTimeZone(ctx.settings), now);
}

/** `{ date: { gte: floor } }` on a session, or nothing when unbounded. */
function sessionSince(floor: Date | null): Prisma.SessionWhereInput {
  return floor ? { date: { gte: floor } } : {};
}

/** Raises a range's start to the history floor; never narrows otherwise. */
function rangeSince<T extends { start: Date; end: Date }>(range: T, floor: Date | null): T {
  return floor && range.start < floor ? { ...range, start: floor } : range;
}

// ── Dashboard: per-center summary, unioned into a combined view ────────────

/**
 * One centre's "today", calendar week (Sunday-start) and calendar month for
 * the teacher dashboard (R7b). Resolved from **that centre's own timezone** —
 * a teacher's centres may sit in different zones, so each per-centre query
 * gets its own day and only the resulting counts are summed
 * (`combineTeacherSummaries`); there is no single global "today". `now` is
 * injectable so the gate can pin the boundary.
 */
export function teacherDashboardAnchors(
  timeZone: string,
  now: Date = new Date(),
): { today: Date; week: { start: Date; end: Date }; month: { start: Date; end: Date } } {
  const today = todayInTimezone(timeZone, now);
  return { today, week: weekRangeUtc(today), month: monthRangeUtc(today) };
}

export type TeacherCenterSummary = {
  centerId: string;
  sessionsToday: number;
  sessionsThisWeek: number;
  /** The teacher's own share only — never the center's cut (spec §4.2 item 1). */
  earnings: { collected: number; teacherShare: number; paymentCount: number };
};

/**
 * One center's slice of the teacher dashboard: how many sessions they teach
 * today/this week at *this* center, and their own earnings in `range` at
 * *this* center — read via `revenueTotals`'s existing `teacherId` filter
 * (lib/db/analytics.ts), which is already centerId-scoped.
 */
export async function teacherCenterSummary(
  db: Db,
  centerId: string,
  teacherId: string,
  today: Date,
  weekRange: { start: Date; end: Date },
  earningsRange: DateRange,
  // U6: the teacher's own history floor (`teacherPortalHistoryFloor`) — a
  // week or month reaching past it counts from the floor instead.
  historyFloor: Date | null = null,
): Promise<TeacherCenterSummary> {
  const week = rangeSince(weekRange, historyFloor);
  const earningsFrom =
    historyFloor && (!earningsRange.from || earningsRange.from < historyFloor) ? historyFloor : earningsRange.from;
  const [sessionsToday, sessionsThisWeek, earnings] = await Promise.all([
    // R4: a deactivated class's sessions count only once they are closed
    // records (`OPEN_CLASS_SESSION`).
    db.session.count({
      where: scopedWhere(centerId, {
        teacherId,
        date: today,
        status: { not: CANCELLED_STATUS },
        ...NOT_MOVED_SESSION,
        ...OPEN_CLASS_SESSION,
      }),
    }),
    db.session.count({
      where: scopedWhere(centerId, {
        teacherId,
        date: { gte: week.start, lte: week.end },
        status: { not: CANCELLED_STATUS },
        ...NOT_MOVED_SESSION,
        ...OPEN_CLASS_SESSION,
      }),
    }),
    revenueTotals(db, centerId, { from: earningsFrom, to: earningsRange.to }, teacherId),
  ]);

  return {
    centerId,
    sessionsToday,
    sessionsThisWeek,
    earnings: {
      collected: earnings.collected,
      teacherShare: earnings.teacherShare,
      paymentCount: earnings.paymentCount,
    },
  };
}

/** Pure — sums a set of already-scoped per-center summaries. Never queries. */
export function combineTeacherSummaries(summaries: TeacherCenterSummary[]): {
  centerCount: number;
  sessionsToday: number;
  sessionsThisWeek: number;
  teacherShare: number;
} {
  return summaries.reduce(
    (total, summary) => ({
      centerCount: total.centerCount + 1,
      sessionsToday: total.sessionsToday + summary.sessionsToday,
      sessionsThisWeek: total.sessionsThisWeek + summary.sessionsThisWeek,
      teacherShare: total.teacherShare + summary.earnings.teacherShare,
    }),
    { centerCount: 0, sessionsToday: 0, sessionsThisWeek: 0, teacherShare: 0 },
  );
}

// ── Sessions: search by student, filter by date/status/grade ───────────────

/**
 * The teacher's own session list for one center — always pinned to
 * `teacherId`, so a teacher never sees another teacher's schedule even
 * within a center they both belong to. `studentQuery` matches a student
 * either enrolled in the class or ever an attendee of it (spec §4.2 item 2
 * "search by student"), covering both regulars and drop-ins/future roster.
 * R4: a deactivated class's sessions show only once they are closed records
 * (`OPEN_CLASS_SESSION`) — its history stays, its future is gone.
 */
export function teacherSessionListWhere(filters: {
  teacherId: string;
  from: Date;
  to: Date;
  gradeId?: string | null;
  studentQuery?: string | null;
}): Prisma.SessionWhereInput {
  const and: Prisma.SessionWhereInput[] = [OPEN_CLASS_SESSION];
  // A class session's grade is its class's; a one-time session's its own (R5).
  if (filters.gradeId) {
    and.push({
      OR: [{ classGroup: { gradeId: filters.gradeId } }, { classGroupId: null, gradeId: filters.gradeId }],
    });
  }
  const where: Prisma.SessionWhereInput = {
    teacherId: filters.teacherId,
    date: { gte: filters.from, lte: filters.to },
    AND: and,
  };

  // SEC-61: LIKE pattern characters removed — Prisma cannot escape them. A
  // query that was only such characters matches nobody, never everyone.
  const typed = filters.studentQuery?.trim() ?? "";
  const query = likeSearchToken(typed);
  if (typed) {
    const contains = { contains: query, mode: "insensitive" as const };
    const studentMatch: Prisma.StudentProfileWhereInput = query === "" ? { id: { in: [] } } : {
      OR: [
        { studentCode: contains },
        { firstName: contains },
        { lastName: contains },
        { user: { firstName: contains } },
        { user: { lastName: contains } },
      ],
    };
    where.OR = [
      { classGroup: { enrollments: { some: { studentProfile: studentMatch } } } },
      { attendees: { some: { studentProfile: studentMatch } } },
    ];
  }

  return where;
}

// ── Students: everyone this teacher has ever taught, at this center ────────

/**
 * Distinct students this teacher has an attendance record with at this
 * center — the roster spec §4.2 item 3 means by "search by code/name/phone":
 * not the class's full enrollment list, but who actually sat with this
 * teacher (drop-ins included, since an attendee row exists for them too).
 */
export async function teacherStudentProfileIds(
  db: Db,
  centerId: string,
  teacherId: string,
  // U6: the portal's history floor; a write's integrity check passes none.
  historyFloor: Date | null = null,
): Promise<string[]> {
  const rows = await db.sessionAttendee.findMany({
    where: scopedWhere(centerId, {
      session: { teacherId, ...sessionSince(historyFloor) },
      studentProfileId: { not: null },
    }),
    distinct: ["studentProfileId"],
    select: { studentProfileId: true },
  });
  return rows
    .map((row) => row.studentProfileId)
    .filter((id): id is string => id !== null);
}

/**
 * The same "taught by this teacher here" set as `teacherStudentProfileIds`,
 * as a relational `where` on `StudentProfile` (SEC-2c, SEC-52): a type-ahead
 * filters in the database instead of loading the teacher's all-history roster
 * on every keystroke.
 */
export function taughtByTeacherWhere(
  centerId: string,
  teacherId: string,
  historyFloor: Date | null = null,
): Prisma.StudentProfileWhereInput {
  return { attendees: { some: scopedWhere(centerId, { session: { teacherId, ...sessionSince(historyFloor) } }) } };
}

/**
 * Every session this student attended with *this* teacher only (spec §4.2
 * item 3) — never the student's full cross-teacher history, which would leak
 * other teachers' sessions to this one.
 */
export function studentSessionsWithTeacher(
  db: Db,
  centerId: string,
  teacherId: string,
  studentProfileId: string,
  historyFloor: Date | null = null,
) {
  const withSelection = { include: { selections: { where: { centerId } } } } as const;
  return db.sessionAttendee.findMany({
    where: scopedWhere(centerId, {
      studentProfileId,
      session: { teacherId, ...sessionSince(historyFloor) },
      // T5 — a drop-in's ABSENT row is not a session they had with this teacher.
      ...EXCLUDE_DROP_IN_NO_SHOWS,
    }),
    orderBy: { session: { date: "desc" } },
    include: {
      session: {
        include: {
          classGroup: { include: { subject: withSelection, grade: withSelection } },
          // R5 — a one-time session's own subject/grade (no class).
          subject: withSelection,
          grade: withSelection,
        },
      },
      payments: { where: { voided: false }, orderBy: { recordedAt: "desc" }, take: 1 },
    },
  });
}
