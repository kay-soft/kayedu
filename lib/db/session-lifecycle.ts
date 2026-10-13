import { Prisma } from "@prisma/client";
import type {
  AttendanceStatus,
  PrismaClient,
  Session,
  SessionCloseMode,
  SessionStatus,
  ShareType,
} from "@prisma/client";
// Relative imports on purpose: `npm run check:session-lifecycle` (and every
// other gate/seed that writes attendance or money) exercises this module
// directly, outside the Next.js runtime — the same reason lib/db/payments.ts
// and lib/db/attendance.ts are written this way (docs/02 §5).
import {
  DEFAULT_TIMEZONE,
  dateKey,
  endOfSessionDay,
  isSessionDayOver,
  parseTimeToMinutes,
  zonedClock,
} from "../scheduling.ts";

/**
 * Session lifecycle (R2, docs/00-master-product-spec.md §5.1 "Session
 * lifecycle", docs/02-architecture.md §11). **The single owner of the
 * closed-session rule** — nothing else decides whether a session still
 * accepts a write.
 *
 * - A session is **closed** once `closedAt` is set (MANUAL: staff pressed
 *   "End session"), or once its calendar day has ended in the centre's
 *   timezone (AUTO). A closed session is an immutable record: no attendance,
 *   payment, void, refund, cancel, reschedule or cut override is accepted.
 *   There is no reopen path anywhere.
 * - There is no cron. The end-of-day close happens **lazily**: the next
 *   read or write that touches the session stamps `closedAt`/`closeMode:
 *   AUTO`/`status: COMPLETED` and materializes enrolled no-shows as ABSENT
 *   (`materializeAbsences`) in the same transaction. A write that triggered
 *   it is then refused — the close commits, the write does not happen.
 * - CANCELLED and rescheduled sessions are terminal states of their own and
 *   never close (M15's guard keeps refusing new attendance/payment on them).
 *
 * Every write path calls `ensureSessionOpenOrAutoClose` first:
 * `changeAttendanceStatus`/`updateAttendanceStatus` (lib/db/attendance.ts),
 * `recordPayment`/`voidPayment` (lib/db/payments.ts),
 * `refundPayment` (lib/db/refunds.ts), `cancelSession`/`rescheduleSession`/
 * `updateSessionShareOverride` (lib/db/sessions.ts). `createAttendance`
 * makes the same decision with the same helpers, then inserts in one
 * statement that is atomic with the closure check. Settlement creation
 * (lib/db/settlements.ts) uses `closeSessionIfDayOver`/`closeEndedSessionsInRange`
 * the other way round — it requires closure rather than refusing it.
 *
 * `historicalBackfill: true` is a narrow escape hatch for **scripts only**
 * (prisma/seed.ts and the `check:*` gates write history against past-dated
 * sessions): it skips the closure check and the lazy close, never the
 * cancelled/rescheduled refusal. `npm run check:session-lifecycle` asserts
 * statically that no file under `app/` ever passes it.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** `recordedBy` on ABSENT rows the close materializes — no human recorded them. */
export const SYSTEM_ACTOR_ID = "system";

export type SessionClosedReason = "sessionCancelled" | "sessionRescheduled" | "sessionClosed";

/**
 * Thrown by the attendance write path when a session no longer accepts a
 * write: CANCELLED, already rescheduled (M15), or closed (R2). The M15 class,
 * moved here and extended with `sessionClosed` — there is exactly one
 * closed-session error in the codebase. A thrown error rather than a result
 * union so the legacy-shaped `createAttendance`/`updateAttendanceStatus`
 * keep returning a plain `SessionAttendee` (the same shape `PermissionError`
 * uses in lib/auth/permissions.ts); the money functions return the same
 * reasons as `{ ok: false, error }` instead.
 */
export class SessionClosedError extends Error {
  reason: SessionClosedReason;

  constructor(reason: SessionClosedReason) {
    super(`Session is ${reason}.`);
    this.name = "SessionClosedError";
    this.reason = reason;
  }
}

/**
 * Options every guarded write accepts. `now` is the injectable clock (the
 * gate tests the end-of-day edge with it). `historicalBackfill` — scripts
 * only, see the module comment.
 */
export type SessionWriteOptions = {
  now?: Date;
  historicalBackfill?: true;
};

/**
 * The acquire/run budget for every session write transaction — the ones this
 * module opens itself and the money transactions the Server Actions open
 * around `recordPayment`/`voidPayment`/`refundPayment`/settlements. A rush of
 * check-ins queues for pooled connections (docs/02 §14); Prisma's 2-second
 * default acquire wait (`maxWait`) turns that queue into failed check-ins
 * long before the database is actually struggling, and the R2 closure guard
 * (a row lock per write) makes each transaction a little longer than before.
 */
export const WRITE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/** Runs `fn` in a transaction — or inside the caller's, when given one. */
export async function runInTransaction<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db) return (db as PrismaClient).$transaction(fn, WRITE_TRANSACTION_OPTIONS);
  return fn(db);
}

/** The centre's configured timezone (`CenterSettings.timezone`). */
export async function centerTimeZone(db: Db, centerId: string): Promise<string> {
  const settings = await db.centerSettings.findUnique({
    where: { centerId },
    select: { timezone: true },
  });
  return settings?.timezone ?? DEFAULT_TIMEZONE;
}

/**
 * Closed = `closedAt` set, or the session's day has ended in `timeZone`
 * (it will be stamped AUTO on its next touch). CANCELLED and rescheduled
 * sessions are never "closed" — they are terminal in their own way.
 */
export function isSessionClosed(
  session: {
    closedAt: Date | null;
    date: Date;
    status?: SessionStatus;
    rescheduledToId?: string | null;
  },
  now: Date,
  timeZone: string,
): boolean {
  if (session.closedAt) return true;
  if (session.status === "CANCELLED" || session.rescheduledToId) return false;
  return isSessionDayOver(session.date, now, timeZone);
}

/**
 * Everything the closure guard — and the check-in and payment paths right
 * behind it — read about a session: the session's own columns, its class's
 * late threshold and cut, and the centre's timezone and default threshold.
 * One joined row, one round trip (`loadGateSession`); Prisma's nested
 * `select` would split this into four queries, and on the reception desk's
 * hot path every round trip is felt (docs/02 §14, `check:performance`).
 */
export type GateSession = {
  id: string;
  centerId: string;
  /** Null for a one-time session (R5) — every `class*` column below is then null too. */
  classGroupId: string | null;
  teacherId: string;
  date: Date;
  startTime: string;
  endTime: string;
  status: SessionStatus;
  rescheduledToId: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  closeMode: SessionCloseMode | null;
  priceSnapshot: number;
  centerShareType: ShareType | null;
  centerShareValue: number | null;
  classLateThresholdMinutes: number | null;
  classCenterShareType: ShareType | null;
  classCenterShareValue: number | null;
  timezone: string | null;
  defaultLateThreshold: number | null;
};

const GATE_COLUMNS = Prisma.sql`s."id", s."centerId", s."classGroupId", s."teacherId", s."date",
  s."startTime", s."endTime", s."status", s."rescheduledToId", s."closedAt", s."closedBy",
  s."closeMode", s."priceSnapshot", s."centerShareType", s."centerShareValue",
  cg."lateThresholdMinutes" AS "classLateThresholdMinutes",
  cg."centerShareType" AS "classCenterShareType",
  cg."centerShareValue" AS "classCenterShareValue",
  cs."timezone", cs."defaultLateThreshold"`;

// LEFT JOIN since R5: a one-time session has no class, and an inner join
// would make it look "missing" to every write path. Its late threshold then
// falls back to the centre's default (`resolveLateThreshold`) and its cut is
// its own (`recordPayment`).
const GATE_FROM = Prisma.sql`"Session" s
  LEFT JOIN "ClassGroup" cg ON cg."id" = s."classGroupId"
  LEFT JOIN "CenterSettings" cs ON cs."centerId" = s."centerId"`;

/** One session's `GateSession` row, scoped to `centerId` — unlocked. */
export async function loadGateSession(
  db: Db,
  centerId: string,
  sessionId: string,
): Promise<GateSession | null> {
  const rows = await db.$queryRaw<GateSession[]>`
    SELECT ${GATE_COLUMNS} FROM ${GATE_FROM}
    WHERE s."id" = ${sessionId} AND s."centerId" = ${centerId}`;
  return rows[0] ?? null;
}

/** The `GateSession` of a roster row's session, scoped to `centerId` — unlocked. */
export async function loadGateSessionForAttendee(
  db: Db,
  centerId: string,
  attendeeId: string,
): Promise<GateSession | null> {
  const rows = await db.$queryRaw<GateSession[]>`
    SELECT ${GATE_COLUMNS}
    FROM "SessionAttendee" a
    JOIN "Session" s ON s."id" = a."sessionId"
    LEFT JOIN "ClassGroup" cg ON cg."id" = s."classGroupId"
    LEFT JOIN "CenterSettings" cs ON cs."centerId" = s."centerId"
    WHERE a."id" = ${attendeeId} AND a."centerId" = ${centerId} AND s."centerId" = ${centerId}`;
  return rows[0] ?? null;
}

export type SessionGate =
  | { status: "open"; session: GateSession; timeZone: string }
  | { status: "missing" }
  | { status: "refused"; reason: SessionClosedReason; autoClosed: boolean };

export function gateTimeZone(session: GateSession): string {
  return session.timezone ?? DEFAULT_TIMEZONE;
}

/**
 * Row-locks the session so a close and a write on the same session
 * serialize — whichever commits second sees the other's effect:
 *
 * - `"share"` (`FOR SHARE`) — an ordinary write (check-in, correction,
 *   payment, void, refund). Writers share it, so a rush of check-ins on one
 *   session still runs concurrently (`npm run check:performance`); it only
 *   conflicts with an exclusive lock.
 * - `"update"` (`FOR UPDATE`) — closing the session, or a write that changes
 *   the session row itself (cancel, reschedule, cut override). It waits for
 *   every in-flight writer to commit, and every writer that arrives after it
 *   waits for it and then sees `closedAt`.
 *
 * A no-op outside a transaction, which is why every caller goes through
 * `runInTransaction` (or the caller's own transaction) first.
 */
async function lockAndLoadSession(
  tx: Db,
  centerId: string,
  sessionId: string,
  mode: "share" | "update",
  peeked?: GateSession,
): Promise<GateSession | null> {
  type LockedRow = {
    status: SessionStatus;
    rescheduledToId: string | null;
    closedAt: Date | null;
    closedBy: string | null;
    closeMode: SessionCloseMode | null;
  };
  // The lock query itself returns the columns a concurrent write can change,
  // so a session already read moments earlier needs no third round trip.
  const rows =
    mode === "share"
      ? await tx.$queryRaw<LockedRow[]>`SELECT "status", "rescheduledToId", "closedAt", "closedBy", "closeMode" FROM "Session" WHERE "id" = ${sessionId} AND "centerId" = ${centerId} FOR SHARE`
      : await tx.$queryRaw<LockedRow[]>`SELECT "status", "rescheduledToId", "closedAt", "closedBy", "closeMode" FROM "Session" WHERE "id" = ${sessionId} AND "centerId" = ${centerId} FOR UPDATE`;
  const locked = rows[0];
  if (!locked) return null;
  const base = peeked ?? (await loadGateSession(tx, centerId, sessionId));
  if (!base) return null;
  return { ...base, ...locked };
}

/**
 * `SELECT … FOR UPDATE` on one roster row. Taken after the session's shared
 * lock by `changeAttendanceStatus` and `recordPayment`, so two writes on the
 * same student serialize (no payment slips in for a student being switched
 * to Absent; no second active payment) while different students in the same
 * session still proceed concurrently.
 */
export async function lockAttendeeRow(
  tx: Db,
  attendeeId: string,
): Promise<{
  attendanceStatus: AttendanceStatus;
  studentProfileId: string | null;
  hasActivePayment: boolean;
} | null> {
  // The current status and "is there an active (non-voided) payment" are
  // returned by the lock query itself — the facts a concurrent write on
  // this student could change, read only once the lock is held.
  const rows = await tx.$queryRaw<
    { attendanceStatus: AttendanceStatus; studentProfileId: string | null; hasActivePayment: boolean }[]
  >`SELECT a."attendanceStatus", a."studentProfileId",
      EXISTS (SELECT 1 FROM "Payment" p WHERE p."sessionAttendeeId" = a."id" AND p."voided" = false) AS "hasActivePayment"
    FROM "SessionAttendee" a WHERE a."id" = ${attendeeId} FOR UPDATE OF a`;
  return rows[0] ?? null;
}

/**
 * The closure guard every write path calls first (R2). Must run inside the
 * write's own transaction.
 *
 * - `allowTerminal` — void/refund pass this: a CANCELLED or rescheduled
 *   session still lets staff undo money it already carries (cancelling never
 *   touches money; undoing it is `voidPayment`'s separate job, docs/02 §11).
 *   Everything else refuses new activity on a terminal session, as at M15.
 * - `exclusive` — the caller is about to update the session row itself
 *   (cancel/reschedule/cut override), so it takes the exclusive lock up front
 *   rather than upgrading a shared one (two upgraders deadlock).
 * - A session whose day has ended but has no `closedAt` is closed right here
 *   (AUTO, with absences materialized) and the write is refused. The close is
 *   returned as a value, not thrown, so the caller's transaction commits it.
 *   Whether that is due is decided from one unlocked read and the single
 *   `now`, *before* locking, so the guard knows up front which lock to take —
 *   the day being over is monotonic, so the decision cannot go stale.
 */
export async function ensureSessionOpenOrAutoClose(
  tx: Db,
  sessionId: string,
  centerId: string,
  now: Date = new Date(),
  options: {
    allowTerminal?: boolean;
    historicalBackfill?: true;
    exclusive?: boolean;
    /**
     * The session as the caller already read it (`loadGateSession`),
     * unlocked — saves a round trip. Only the columns a concurrent write can
     * change are trusted, and those are re-read by the lock query itself.
     */
    peeked?: GateSession;
  } = {},
): Promise<SessionGate> {
  const peek = options.peeked ?? (await loadGateSession(tx, centerId, sessionId));
  if (!peek || peek.id !== sessionId || peek.centerId !== centerId) return { status: "missing" };

  const timeZone = gateTimeZone(peek);
  const isTerminal = (row: GateSession) =>
    row.status === "CANCELLED" || Boolean(row.rescheduledToId);
  const dueForAutoClose =
    !options.historicalBackfill &&
    !peek.closedAt &&
    !isTerminal(peek) &&
    isSessionDayOver(peek.date, now, timeZone);

  const session = await lockAndLoadSession(
    tx,
    centerId,
    sessionId,
    dueForAutoClose || options.exclusive ? "update" : "share",
    peek,
  );
  if (!session) return { status: "missing" };

  if (!options.allowTerminal) {
    if (session.status === "CANCELLED") {
      return { status: "refused", reason: "sessionCancelled", autoClosed: false };
    }
    if (session.rescheduledToId) {
      return { status: "refused", reason: "sessionRescheduled", autoClosed: false };
    }
  }

  if (options.historicalBackfill) return { status: "open", session, timeZone };

  if (session.closedAt) return { status: "refused", reason: "sessionClosed", autoClosed: false };
  if (isTerminal(session)) return { status: "open", session, timeZone };

  if (dueForAutoClose) {
    const { closed } = await closeLockedSession(tx, session, {
      mode: "AUTO",
      closedBy: null,
      closedAt: endOfSessionDay(session.date, timeZone),
    });
    return { status: "refused", reason: "sessionClosed", autoClosed: closed };
  }

  return { status: "open", session, timeZone };
}

/**
 * Every ACTIVE enrolled student with no roster row gets an ABSENT row
 * (`isDropIn: false`, `enrollmentId` set, `recordedBy: "system"`).
 * Idempotent: `createMany({ skipDuplicates: true })` against the
 * `(sessionId, studentProfileId)` unique index, so closing twice — or two
 * closes racing — never duplicates a row. Only enrolments that existed
 * before the session's day ended count: a student who enrols next week is
 * not absent from a session that a late lazy close happens to touch.
 * A student never enrolled and never checked in gets nothing — which is
 * everyone at a one-time session (R5): it has no class, so nobody is enrolled
 * and nobody is marked absent.
 */
export async function materializeAbsences(
  tx: Db,
  session: { id: string; centerId: string; classGroupId: string | null; date: Date },
  recordedAt: Date,
  timeZone: string,
): Promise<number> {
  if (session.classGroupId === null) return 0;
  const enrollments = await tx.enrollment.findMany({
    where: {
      centerId: session.centerId,
      classGroupId: session.classGroupId,
      status: "ACTIVE",
      enrolledAt: { lt: endOfSessionDay(session.date, timeZone) },
    },
    select: { id: true, studentProfileId: true },
  });
  if (enrollments.length === 0) return 0;

  const absent: AttendanceStatus = "ABSENT";
  const result = await tx.sessionAttendee.createMany({
    data: enrollments.map((enrollment) => ({
      centerId: session.centerId,
      sessionId: session.id,
      studentProfileId: enrollment.studentProfileId,
      enrollmentId: enrollment.id,
      isDropIn: false,
      attendanceStatus: absent,
      recordedBy: SYSTEM_ACTOR_ID,
      recordedAt,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * Stamps the close and materializes absences, on a session row the caller
 * already holds the lock for. `updateMany … where closedAt: null` makes the
 * stamp itself idempotent; returns whether this call was the one that closed it.
 */
async function closeLockedSession(
  tx: Db,
  session: GateSession,
  params: { mode: SessionCloseMode; closedBy: string | null; closedAt: Date },
): Promise<{ closed: boolean; absentCreated: number }> {
  const completed: SessionStatus = "COMPLETED";
  const stamped = await tx.session.updateMany({
    where: { id: session.id, centerId: session.centerId, closedAt: null },
    data: {
      closedAt: params.closedAt,
      closedBy: params.closedBy,
      closeMode: params.mode,
      status: completed,
    },
  });
  if (stamped.count === 0) return { closed: false, absentCreated: 0 };

  const absentCreated = await materializeAbsences(
    tx,
    session,
    params.closedAt,
    gateTimeZone(session),
  );

  // A MANUAL close is audited by the Server Action that performed it
  // (`endSessionAction`, the docs/02 §7 shape). An AUTO close has no action
  // and no human actor, so its `session.close` row is written here, in the
  // same transaction, with `actorUserId: null`.
  if (params.mode === "AUTO") {
    await tx.auditLog.create({
      data: {
        centerId: session.centerId,
        actorUserId: null,
        action: "session.close",
        entityType: "Session",
        entityId: session.id,
        before: { status: session.status, closedAt: null },
        after: { status: completed, closeMode: "AUTO", closedAt: params.closedAt, absentCreated },
      },
    });
  }
  return { closed: true, absentCreated };
}

export type CloseSessionResult =
  | { ok: true; session: Session; absentCreated: number }
  | {
      ok: false;
      error: "notFound" | "sessionCancelled" | "sessionRescheduled" | "alreadyClosed" | "notStarted";
    };

/**
 * "End session" (R2) — a MANUAL close by staff. Refuses a CANCELLED or
 * rescheduled session, an already-closed one, and one that has not started
 * yet (closing is irreversible, and a session closed before it began would
 * mark every enrolled student absent from a class that never ran). A session
 * whose day already ended closes AUTO here instead — it was due anyway — and
 * reports `alreadyClosed`. The caller audits `session.close`.
 */
export async function closeSession(
  db: Db,
  centerId: string,
  sessionId: string,
  params: { closedBy: string; now?: Date },
): Promise<CloseSessionResult> {
  const now = params.now ?? new Date();
  return runInTransaction(db, async (tx) => {
    const session = await lockAndLoadSession(tx, centerId, sessionId, "update");
    if (!session) return { ok: false, error: "notFound" };
    if (session.status === "CANCELLED") return { ok: false, error: "sessionCancelled" };
    if (session.rescheduledToId) return { ok: false, error: "sessionRescheduled" };
    if (session.closedAt) return { ok: false, error: "alreadyClosed" };

    const timeZone = gateTimeZone(session);
    if (isSessionDayOver(session.date, now, timeZone)) {
      await closeLockedSession(tx, session, {
        mode: "AUTO",
        closedBy: null,
        closedAt: endOfSessionDay(session.date, timeZone),
      });
      return { ok: false, error: "alreadyClosed" };
    }

    const clock = zonedClock(now, timeZone);
    const beforeDay = clock.dayKey < dateKey(session.date);
    if (beforeDay || clock.minutes < parseTimeToMinutes(session.startTime)) {
      return { ok: false, error: "notStarted" };
    }

    const { absentCreated } = await closeLockedSession(tx, session, {
      mode: "MANUAL",
      closedBy: params.closedBy,
      closedAt: now,
    });
    const closed = await tx.session.findUniqueOrThrow({ where: { id: session.id } });
    return { ok: true, session: closed, absentCreated };
  });
}

/**
 * The lazy close for a **read** path (session detail, print, receipt): if
 * this one session's day has ended and nobody closed it, close it now.
 * Returns true when this call closed it.
 */
export async function closeSessionIfDayOver(
  db: Db,
  centerId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return runInTransaction(db, async (tx) => {
    const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, now, {
      allowTerminal: true,
    });
    return gate.status === "refused" && gate.autoClosed;
  });
}

const ENDED_SWEEP_LIMIT = 200;

/**
 * The lazy close for list/dashboard reads: every un-closed, non-terminal
 * session of this centre whose day has ended (optionally narrowed to a date
 * range and/or one teacher) is closed AUTO, each in its own short
 * transaction. One indexed query when there is nothing to close — which,
 * after the first touch of the day, is the normal case. Bounded per call.
 */
export async function closeEndedSessions(
  db: PrismaClient,
  centerId: string,
  now: Date = new Date(),
  scope: { from?: Date; to?: Date; teacherId?: string; classGroupId?: string } = {},
): Promise<number> {
  const timeZone = await centerTimeZone(db, centerId);
  const todayStart = new Date(`${zonedClock(now, timeZone).dayKey}T00:00:00.000Z`);
  const dateFilter: Prisma.DateTimeFilter = { lt: todayStart };
  if (scope.from) dateFilter.gte = scope.from;
  if (scope.to && scope.to < todayStart) {
    // Inclusive `to` on a UTC-midnight day marker: anything before the next day.
    const dayAfter = new Date(scope.to);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    dateFilter.lt = dayAfter < todayStart ? dayAfter : todayStart;
  }
  const cancelled: SessionStatus = "CANCELLED";
  const candidates = await db.session.findMany({
    where: {
      centerId,
      closedAt: null,
      rescheduledToId: null,
      status: { not: cancelled },
      date: dateFilter,
      ...(scope.teacherId ? { teacherId: scope.teacherId } : {}),
      ...(scope.classGroupId ? { classGroupId: scope.classGroupId } : {}),
    },
    select: { id: true },
    orderBy: { date: "asc" },
    take: ENDED_SWEEP_LIMIT,
  });

  let closed = 0;
  for (const candidate of candidates) {
    if (await closeSessionIfDayOver(db, centerId, candidate.id, now)) closed++;
  }
  return closed;
}

// ── Receipt data (R2: closed time/mode + "Changes during session") ─────────

export type SessionAttendanceChangeRow = {
  id: string;
  studentProfileId: string;
  studentName: { firstName: string; lastName: string };
  fromStatus: AttendanceStatus;
  toStatus: AttendanceStatus;
  changedAt: Date;
  changedBy: string;
  changedByName: { firstName: string; lastName: string } | null;
  reason: string | null;
  voidedPaymentId: string | null;
};

/**
 * Every live-session status change on this session, oldest first — the
 * receipt's "Changes during session" section. Names resolve the same way
 * every other screen resolves them (CLAUDE.md rule 4): the student's
 * centre-local name over their global default, and the actor's centre-local
 * `Membership` name over theirs.
 */
export async function listSessionAttendanceChanges(
  db: Db,
  centerId: string,
  sessionId: string,
): Promise<SessionAttendanceChangeRow[]> {
  const rows = await db.sessionAttendanceChange.findMany({
    where: { centerId, sessionId },
    orderBy: { changedAt: "asc" },
    include: { studentProfile: { include: { user: true } } },
  });
  if (rows.length === 0) return [];

  const actorIds = [...new Set(rows.map((row) => row.changedBy))];
  const [users, memberships] = await Promise.all([
    db.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, firstName: true, lastName: true },
    }),
    db.membership.findMany({
      where: { centerId, userId: { in: actorIds } },
      select: { userId: true, firstName: true, lastName: true },
    }),
  ]);
  const userById = new Map(users.map((user) => [user.id, user]));
  const membershipByUserId = new Map(memberships.map((m) => [m.userId, m]));

  return rows.map((row) => {
    const user = userById.get(row.changedBy);
    const membership = membershipByUserId.get(row.changedBy);
    return {
      id: row.id,
      studentProfileId: row.studentProfileId,
      studentName: {
        firstName: row.studentProfile.firstName ?? row.studentProfile.user.firstName,
        lastName: row.studentProfile.lastName ?? row.studentProfile.user.lastName,
      },
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      changedAt: row.changedAt,
      changedBy: row.changedBy,
      changedByName: user
        ? {
            firstName: membership?.firstName ?? user.firstName,
            lastName: membership?.lastName ?? user.lastName,
          }
        : null,
      reason: row.reason,
      voidedPaymentId: row.voidedPaymentId,
    };
  });
}

export type SessionClosure = {
  closedAt: Date;
  closeMode: SessionCloseMode;
  closedByName: { firstName: string; lastName: string } | null;
} | null;

/** Who closed the session and how — the closed banner and the receipt. */
export async function sessionClosure(
  db: Db,
  centerId: string,
  session: { closedAt: Date | null; closeMode: SessionCloseMode | null; closedBy: string | null },
): Promise<SessionClosure> {
  if (!session.closedAt || !session.closeMode) return null;
  if (!session.closedBy) {
    return { closedAt: session.closedAt, closeMode: session.closeMode, closedByName: null };
  }
  const [user, membership] = await Promise.all([
    db.user.findUnique({
      where: { id: session.closedBy },
      select: { firstName: true, lastName: true },
    }),
    db.membership.findFirst({
      where: { centerId, userId: session.closedBy },
      select: { firstName: true, lastName: true },
    }),
  ]);
  return {
    closedAt: session.closedAt,
    closeMode: session.closeMode,
    closedByName: user
      ? {
          firstName: membership?.firstName ?? user.firstName,
          lastName: membership?.lastName ?? user.lastName,
        }
      : null,
  };
}
