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
 * Thrown by `createAttendance`/`updateAttendanceStatus` when the session is
 * CANCELLED or has already been rescheduled onto a replacement (M15, spec §7
 * criterion 17 / §5.1 "Reschedule with linkage") — the single choke point
 * every attendance write funnels through, so a future caller cannot forget
 * the check the way every existing caller did (docs/00 §7.1's verified gap).
 * A thrown error rather than a result union on purpose: every pre-existing
 * caller (throwaway fixtures in `scripts/*-check.ts`, `prisma/seed.ts`) never
 * hits this path and keeps working against the exact same `SessionAttendee`
 * return type unchanged — only the production Server Actions that must
 * surface this as a user-facing refusal catch it (the same shape
 * `PermissionError`/`assertCan` already establishes in `lib/auth/permissions.ts`).
 */
export class SessionClosedError extends Error {
  reason: "sessionCancelled" | "sessionRescheduled";

  constructor(reason: "sessionCancelled" | "sessionRescheduled") {
    super(`Session is ${reason}.`);
    this.name = "SessionClosedError";
    this.reason = reason;
  }
}

async function assertSessionOpen(db: Db, sessionId: string): Promise<void> {
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: { status: true, rescheduledToId: true },
  });
  if (!session) return; // let the caller's own existence check fail instead.
  if (session.status === "CANCELLED") throw new SessionClosedError("sessionCancelled");
  if (session.rescheduledToId) throw new SessionClosedError("sessionRescheduled");
}

/**
 * First-time mark (`attendance.record`). `enrollmentId`/`isDropIn` are
 * resolved by the caller from the class's active enrollments (docs/01 §1
 * principle 4 — the roster is decoupled from enrollment; drop-in is simply
 * `enrollmentId: null, isDropIn: true`).
 */
export async function createAttendance(
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
  await assertSessionOpen(db, params.sessionId);

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
export async function updateAttendanceStatus(
  db: Db,
  existing: Pick<SessionAttendee, "id" | "sessionId">,
  status: AttendanceStatus,
  recordedBy: string,
): Promise<SessionAttendee> {
  await assertSessionOpen(db, existing.sessionId);

  return db.sessionAttendee.update({
    where: { id: existing.id },
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
