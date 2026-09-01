import type {
  AttendanceStatus,
  Prisma,
  PrismaClient,
  SessionAttendee,
} from "@prisma/client";

/**
 * Roster / attendance writes (M5, spec §5 "Attendance"). Split out from
 * `lib/db/sessions.ts` (which owns session *metadata* — the dashboard, the
 * generator) because this module is specifically the write path CLAUDE.md
 * rule 7 requires an audit trail for: a first-time mark is "record", a
 * changed mark on an already-marked row is "correct" and must be audited.
 *
 * Every function here takes `centerId` explicitly and a Prisma client/tx
 * rather than going through `ScopedDb`, exactly like `lib/db/students.ts`'s
 * `claimStudentCode` — the money-adjacent write path (`recordPayment` in
 * `lib/db/payments.ts`) needs the same shape to share a transaction, and the
 * Server Action is what decides record-vs-correct permission *before*
 * calling in, using `findAttendee` below.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Existing roster row for (session, student), or null if never marked. */
export function findAttendee(
  db: Db,
  centerId: string,
  sessionId: string,
  studentProfileId: string,
): Promise<SessionAttendee | null> {
  return db.sessionAttendee.findFirst({
    where: { centerId, sessionId, studentProfileId },
  });
}

export function findAttendeeById(
  db: Db,
  centerId: string,
  id: string,
): Promise<SessionAttendee | null> {
  return db.sessionAttendee.findFirst({ where: { centerId, id } });
}

/**
 * First-time mark (`attendance.record`). `enrollmentId`/`isDropIn` are
 * resolved by the caller from the class's active enrollments (docs/01 §1
 * principle 4 — the roster is decoupled from enrollment; drop-in is simply
 * `enrollmentId: null, isDropIn: true`).
 */
export function createAttendance(
  db: Db,
  params: {
    centerId: string;
    sessionId: string;
    studentProfileId: string;
    enrollmentId: string | null;
    isDropIn: boolean;
    status: AttendanceStatus;
    recordedBy: string;
  },
): Promise<SessionAttendee> {
  return db.sessionAttendee.create({
    data: {
      centerId: params.centerId,
      sessionId: params.sessionId,
      studentProfileId: params.studentProfileId,
      enrollmentId: params.enrollmentId,
      isDropIn: params.isDropIn,
      attendanceStatus: params.status,
      recordedBy: params.recordedBy,
    },
  });
}

/** A changed mark on an already-marked row — this is the audited "correction". */
export function updateAttendanceStatus(
  db: Db,
  id: string,
  status: AttendanceStatus,
  recordedBy: string,
): Promise<SessionAttendee> {
  return db.sessionAttendee.update({
    where: { id },
    data: { attendanceStatus: status, recordedBy, recordedAt: new Date() },
  });
}

/**
 * How many of a student's most recent sessions *in this class*, counting
 * backwards from (and including) `uptoDate`, were marked ABSENT with no
 * present/late/excused break in between (spec §7 acceptance criterion 13).
 * Capped at 50 rows — a real "in a row" alert never needs more, and this
 * keeps the query bounded without an unnecessary second round-trip to count.
 */
export async function consecutiveAbsenceCount(
  db: Db,
  centerId: string,
  classGroupId: string,
  studentProfileId: string,
  uptoDate: Date,
): Promise<number> {
  const rows = await db.sessionAttendee.findMany({
    where: {
      centerId,
      studentProfileId,
      session: { classGroupId, date: { lte: uptoDate } },
    },
    orderBy: { session: { date: "desc" } },
    select: { attendanceStatus: true },
    take: 50,
  });

  let count = 0;
  for (const row of rows) {
    if (row.attendanceStatus !== "ABSENT") break;
    count++;
  }
  return count;
}
