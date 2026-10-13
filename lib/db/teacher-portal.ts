import type { Prisma, PrismaClient, SessionStatus } from "@prisma/client";

// Relative imports on purpose — `npm run check:teacher-portal` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/analytics.ts and lib/db/sessions.ts).
import { type DateRange, revenueTotals } from "./analytics.ts";
import { OPEN_CLASS_SESSION } from "./slot-conflicts.ts";
import { scopedWhere } from "./tenant-scope.ts";

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

// ── Dashboard: per-center summary, unioned into a combined view ────────────

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
): Promise<TeacherCenterSummary> {
  const [sessionsToday, sessionsThisWeek, earnings] = await Promise.all([
    // R4: a deactivated class's sessions count only once they are closed
    // records (`OPEN_CLASS_SESSION`).
    db.session.count({
      where: scopedWhere(centerId, {
        teacherId,
        date: today,
        status: { not: CANCELLED_STATUS },
        ...OPEN_CLASS_SESSION,
      }),
    }),
    db.session.count({
      where: scopedWhere(centerId, {
        teacherId,
        date: { gte: weekRange.start, lte: weekRange.end },
        status: { not: CANCELLED_STATUS },
        ...OPEN_CLASS_SESSION,
      }),
    }),
    revenueTotals(db, centerId, earningsRange, teacherId),
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

  const query = filters.studentQuery?.trim();
  if (query) {
    const contains = { contains: query, mode: "insensitive" as const };
    const studentMatch: Prisma.StudentProfileWhereInput = {
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
): Promise<string[]> {
  const rows = await db.sessionAttendee.findMany({
    where: scopedWhere(centerId, {
      session: { teacherId },
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
 * Every session this student attended with *this* teacher only (spec §4.2
 * item 3) — never the student's full cross-teacher history, which would leak
 * other teachers' sessions to this one.
 */
export function studentSessionsWithTeacher(
  db: Db,
  centerId: string,
  teacherId: string,
  studentProfileId: string,
) {
  const withSelection = { include: { selections: { where: { centerId } } } } as const;
  return db.sessionAttendee.findMany({
    where: scopedWhere(centerId, {
      studentProfileId,
      session: { teacherId },
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
