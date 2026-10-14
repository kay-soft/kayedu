import type { AttendanceStatus, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:reception` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/sessions.ts).
// The Prisma client is injected for the same reason.
import { centerIdsMatch, parseScannedStudentInput } from "../id-card.ts";
import { fullName, localName } from "../identity.ts";
import { dateKey, todayInTimezone, zonedClock } from "../scheduling.ts";
import { sessionDisplayName, sessionKind, type SessionKind } from "../session-label.ts";
import { findAttendee, isStudentBlockedFromSession } from "./attendance.ts";
import {
  deriveSessionDisplayStatus,
  sessionListSelect,
  type SessionDisplayStatus,
} from "./sessions.ts";
import { sessionTimeZone } from "./session-lifecycle.ts";
import { OPEN_CLASS_SESSION } from "./slot-conflicts.ts";
import { studentSearchWhere } from "./students.ts";

/**
 * The reception desk's reads (R7) — **the one query behind both the page's
 * "Today's sessions" cards and the student session picker**, so the two can
 * never disagree about what is open, who teaches it or what it is called. No
 * money logic and no write lives here: check-in is `checkInAction`, closing is
 * `endSessionAction`, the split is `lib/money.ts`. Everything is filtered by
 * `centerId` (CLAUDE.md rule 1).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const CANCELLED = "CANCELLED" as const;
const PRESENT_OR_LATE: AttendanceStatus[] = ["PRESENT", "LATE"];

// ── Today's sessions ────────────────────────────────────────────────────────

/** What the signed-in role may do on a card — resolved by the caller from the permission matrix. */
export type ReceptionPermissions = { checkIn: boolean; end: boolean };

/** Whether a card offers "End session": hidden, shown-but-disabled (not started yet) or live. */
export type EndControl = "hidden" | "disabled" | "enabled";

export type ReceptionSessionCard = {
  id: string;
  /** `lib/session-label.ts` — a one-time session shows its own title. */
  label: string;
  kind: SessionKind;
  /** The centre-local teacher name (the TEACHER membership's own record); null if none is on file. */
  teacherName: string | null;
  startTime: string;
  endTime: string;
  /** Primary room first, then the combined extras. */
  rooms: string[];
  displayStatus: SessionDisplayStatus;
  closed: boolean;
  /** Closed by the end-of-day sweep rather than by staff. */
  autoClosed: boolean;
  /** PRESENT + LATE on the roster — one grouped query for the whole list. */
  checkedIn: number;
  /** Piastres, straight from `Session.priceSnapshot` — what a payment would freeze. */
  price: number;
  /** Not closed, cancelled or rescheduled: a student can still be checked in. */
  acceptsCheckIn: boolean;
  canAttend: boolean;
  end: EndControl;
  canViewReceipt: boolean;
};

/** Live first, then upcoming by start time, then ended last. */
const STATUS_ORDER: Record<SessionDisplayStatus, number> = {
  LIVE: 0,
  SCHEDULED: 1,
  COMPLETED: 2,
  CANCELLED: 3,
  RESCHEDULED: 3,
};

export async function loadReceptionSessions(
  db: Db,
  params: {
    centerId: string;
    locale: string;
    timeZone: string;
    now: Date;
    permissions: ReceptionPermissions;
  },
): Promise<ReceptionSessionCard[]> {
  const { centerId, locale, timeZone, now, permissions } = params;

  const rows = await db.session.findMany({
    where: {
      centerId,
      date: todayInTimezone(timeZone, now),
      // A cancelled or rescheduled session never happened at this desk, and a
      // deactivated class's sessions are gone unless they are closed records.
      status: { not: CANCELLED },
      rescheduledToId: null,
      ...OPEN_CLASS_SESSION,
    },
    orderBy: [{ startTime: "asc" }],
    select: { ...sessionListSelect(centerId), closeMode: true },
  });
  if (rows.length === 0) return [];

  const sessionIds = rows.map((row) => row.id);
  const teacherIds = [...new Set(rows.map((row) => row.teacherId))];
  const [counts, memberships] = await Promise.all([
    // One grouped query for every card's count (no N+1).
    db.sessionAttendee.groupBy({
      by: ["sessionId"],
      where: { centerId, sessionId: { in: sessionIds }, attendanceStatus: { in: PRESENT_OR_LATE } },
      _count: { _all: true },
    }),
    db.membership.findMany({
      where: { centerId, role: "TEACHER", userId: { in: teacherIds } },
      include: { user: true },
    }),
  ]);
  const checkedInBySession = new Map(counts.map((row) => [row.sessionId, row._count._all]));
  const teacherNameByUserId = new Map(
    memberships.map((membership) => [membership.userId, fullName(localName(membership, membership.user))]),
  );

  const cards = rows.map((row): ReceptionSessionCard => {
    const displayStatus = deriveSessionDisplayStatus(row, now, timeZone);
    const closed = displayStatus === "COMPLETED";
    const acceptsCheckIn = !closed;
    return {
      id: row.id,
      label: sessionDisplayName(locale, row),
      kind: sessionKind(row),
      teacherName: teacherNameByUserId.get(row.teacherId) ?? null,
      startTime: row.startTime,
      endTime: row.endTime,
      rooms: [row.room, ...row.extraRooms.map((extra) => extra.room)]
        .filter((room): room is NonNullable<typeof room> => room !== null)
        .map((room) => room.name),
      displayStatus,
      closed,
      autoClosed: closed && row.closeMode === "AUTO",
      checkedIn: checkedInBySession.get(row.id) ?? 0,
      price: row.priceSnapshot,
      acceptsCheckIn,
      canAttend: acceptsCheckIn && permissions.checkIn,
      end: !permissions.end || closed ? "hidden" : displayStatus === "LIVE" ? "enabled" : "disabled",
      canViewReceipt: closed,
    };
  });

  return cards.sort(
    (a, b) =>
      STATUS_ORDER[a.displayStatus] - STATUS_ORDER[b.displayStatus] ||
      a.startTime.localeCompare(b.startTime) ||
      a.id.localeCompare(b.id),
  );
}

/** "Session name · Teacher · 4:00 PM" — the one label every picker uses; time formatting stays at the call site. */
export function sessionPickerParts(card: Pick<ReceptionSessionCard, "label" | "teacherName">): string[] {
  return [card.label, card.teacherName].filter((part): part is string => Boolean(part));
}

// ── Session mode: is this id one the desk may attend? ───────────────────────

export type ReceptionSessionRefusal =
  | "notFound"
  | "notToday"
  | "cancelled"
  | "rescheduled"
  | "closed"
  | "inactive";

export type ReceptionSessionCheck =
  | {
      ok: true;
      session: {
        id: string;
        date: Date;
        startTime: string;
        endTime: string;
        teacherId: string;
        classGroupId: string | null;
        priceSnapshot: number;
      };
    }
  | { ok: false; reason: ReceptionSessionRefusal };

/**
 * Session mode lives in the URL (`?session=<id>`), so the id is **untrusted
 * input on every request** and is re-validated here every time: it must be a
 * session of this centre, dated today in the centre's timezone, and not
 * cancelled, rescheduled or closed. A session id from another centre is
 * indistinguishable from one that does not exist (`notFound`).
 */
export async function validateReceptionSession(
  db: Db,
  params: { centerId: string; sessionId: string; timeZone: string; now: Date },
): Promise<ReceptionSessionCheck> {
  const { centerId, sessionId, timeZone, now } = params;
  const row = await db.session.findFirst({
    where: { id: sessionId, centerId },
    select: {
      id: true,
      date: true,
      startTime: true,
      endTime: true,
      status: true,
      rescheduledToId: true,
      closedAt: true,
      teacherId: true,
      classGroupId: true,
      priceSnapshot: true,
      timezone: true,
      classGroup: { select: { active: true } },
    },
  });
  if (!row) return { ok: false, reason: "notFound" };
  if (row.status === CANCELLED) return { ok: false, reason: "cancelled" };
  if (row.rescheduledToId) return { ok: false, reason: "rescheduled" };
  if (row.closedAt || deriveSessionDisplayStatus(row, now, timeZone) === "COMPLETED") {
    return { ok: false, reason: "closed" };
  }
  // "Today" for this session is its own frozen timezone's day (D-14).
  if (dateKey(row.date) !== zonedClock(now, sessionTimeZone(row, timeZone)).dayKey) {
    return { ok: false, reason: "notToday" };
  }
  if (row.classGroup && !row.classGroup.active) return { ok: false, reason: "inactive" };
  return {
    ok: true,
    session: {
      id: row.id,
      date: row.date,
      startTime: row.startTime,
      endTime: row.endTime,
      teacherId: row.teacherId,
      classGroupId: row.classGroupId,
      priceSnapshot: row.priceSnapshot,
    },
  };
}

// ── Resolving what was scanned or typed ─────────────────────────────────────

export type ReceptionStudent = {
  id: string;
  userId: string;
  name: string;
  code: string;
  /** A Storage path; the caller signs it. */
  photoPath: string | null;
  active: boolean;
};

export type ResolveStudentResult =
  | { kind: "empty" }
  | { kind: "student"; student: ReceptionStudent }
  /** Several students match a typed name/phone fragment — pick one. */
  | { kind: "candidates"; students: ReceptionStudent[] }
  | { kind: "notFound" }
  /** A real student, but deactivated at this centre. */
  | { kind: "inactive"; student: ReceptionStudent }
  /** A card for another centre. Says nothing about whether the student exists there. */
  | { kind: "otherBranch" }
  /** Card-shaped but not readable (typically a non-English keyboard layout). */
  | { kind: "unreadable" };

const MAX_CANDIDATES = 8;

const studentInclude = { user: true } as const;

type StudentRow = Prisma.StudentProfileGetPayload<{ include: typeof studentInclude }>;

function toReceptionStudent(row: StudentRow): ReceptionStudent {
  return {
    id: row.id,
    userId: row.userId,
    name: fullName(localName(row, row.user)),
    code: row.studentCode,
    photoPath: row.photoUrl,
    active: row.active,
  };
}

/**
 * A scan or a typed value → the student it names, **inside this centre only**.
 * A full card payload for another centre is refused on its centre id alone,
 * before any lookup — the answer never depends on, or reveals, anything stored
 * elsewhere. A bare numeric code is tried as a student code first and then as
 * a phone/name fragment; other text is the same bounded search the type-ahead
 * runs.
 */
export async function resolveStudentInput(
  db: Db,
  params: { centerId: string; raw: string },
): Promise<ResolveStudentResult> {
  const { centerId, raw } = params;
  const parsed = parseScannedStudentInput(raw);

  const byCode = (studentCode: string) =>
    db.studentProfile.findFirst({ where: { centerId, studentCode }, include: studentInclude });

  const one = (row: StudentRow): ResolveStudentResult => {
    const student = toReceptionStudent(row);
    return student.active ? { kind: "student", student } : { kind: "inactive", student };
  };

  const search = async (text: string): Promise<ResolveStudentResult> => {
    const rows = await db.studentProfile.findMany({
      where: { AND: [{ centerId, active: true }, studentSearchWhere(text) ?? {}] },
      include: studentInclude,
      orderBy: [{ studentCode: "asc" }],
      take: MAX_CANDIDATES,
    });
    if (rows.length === 0) return { kind: "notFound" };
    if (rows.length === 1) return one(rows[0]);
    return { kind: "candidates", students: rows.map(toReceptionStudent) };
  };

  switch (parsed.kind) {
    case "empty":
      return { kind: "empty" };
    case "unreadable":
      return { kind: "unreadable" };
    case "payload": {
      if (!centerIdsMatch(parsed.centerId, centerId)) return { kind: "otherBranch" };
      const row = await byCode(parsed.studentCode);
      return row ? one(row) : { kind: "notFound" };
    }
    case "code": {
      const row = await byCode(parsed.studentCode);
      return row ? one(row) : search(parsed.studentCode);
    }
    case "text":
      return search(parsed.text);
  }
}

// ── Can this student be checked in to this session? ─────────────────────────

export type StudentSessionState =
  | { outcome: "ready"; enrolled: boolean }
  | { outcome: "already"; status: AttendanceStatus; recordedAt: Date }
  | { outcome: "blocked" };

/**
 * The pre-confirm look at one student against one (already validated)
 * session. It only reads: "already" when a roster row exists (no duplicate is
 * ever written — `checkInAction` re-checks under the unique key regardless),
 * "blocked" for either `StudentBlock` scope, otherwise "ready" with whether
 * they are actively enrolled in the session's class (a student who is not is
 * checked in as a drop-in, exactly as before).
 */
export async function studentSessionState(
  db: Db,
  params: {
    centerId: string;
    session: { id: string; teacherId: string; classGroupId: string | null };
    student: Pick<ReceptionStudent, "id" | "userId">;
  },
): Promise<StudentSessionState> {
  const { centerId, session, student } = params;
  const existing = await findAttendee(db, centerId, session.id, student.id);
  if (existing) {
    return { outcome: "already", status: existing.attendanceStatus, recordedAt: existing.recordedAt };
  }
  if (await isStudentBlockedFromSession(db, centerId, session, student.userId)) {
    return { outcome: "blocked" };
  }
  const enrollment = session.classGroupId
    ? await db.enrollment.findFirst({
        where: {
          centerId,
          classGroupId: session.classGroupId,
          studentProfileId: student.id,
          status: "ACTIVE",
        },
        select: { id: true },
      })
    : null;
  return { outcome: "ready", enrolled: enrollment !== null };
}

// ── The open sessions a student could be checked in to ──────────────────────

/**
 * For the non-session flow: which of today's cards this student may be
 * checked in to — only sessions that still accept check-in, and with those
 * the one to preselect when exactly one of them is on the student's active
 * enrolments (it still needs the confirm). Reads the cards `loadReceptionSessions`
 * already produced plus one query for the student's enrolled classes.
 */
export async function openSessionsForStudent(
  db: Db,
  params: { centerId: string; studentProfileId: string; cards: ReceptionSessionCard[] },
): Promise<{ options: ReceptionSessionCard[]; preselectId: string | null }> {
  const { centerId, studentProfileId, cards } = params;
  const options = cards.filter((card) => card.canAttend);
  if (options.length === 0) return { options, preselectId: null };

  const enrolled = await db.session.findMany({
    where: {
      centerId,
      id: { in: options.map((card) => card.id) },
      classGroup: { enrollments: { some: { centerId, studentProfileId, status: "ACTIVE" } } },
    },
    select: { id: true },
  });
  return { options, preselectId: enrolled.length === 1 ? enrolled[0].id : null };
}

// ── Recent check-ins on the selected session ────────────────────────────────

export type RecentCheckIn = {
  id: string;
  studentName: string;
  studentCode: string;
  photoPath: string | null;
  status: AttendanceStatus;
  recordedAt: Date;
};

export const RECENT_CHECK_INS = 8;

export async function recentCheckIns(
  db: Db,
  params: { centerId: string; sessionId: string },
): Promise<RecentCheckIn[]> {
  const rows = await db.sessionAttendee.findMany({
    where: {
      centerId: params.centerId,
      sessionId: params.sessionId,
      attendanceStatus: { in: PRESENT_OR_LATE },
      studentProfileId: { not: null },
    },
    orderBy: { recordedAt: "desc" },
    take: RECENT_CHECK_INS,
    include: { studentProfile: { include: { user: true } } },
  });
  return rows.flatMap((row) =>
    row.studentProfile
      ? [
          {
            id: row.id,
            studentName: fullName(localName(row.studentProfile, row.studentProfile.user)),
            studentCode: row.studentProfile.studentCode,
            photoPath: row.studentProfile.photoUrl,
            status: row.attendanceStatus,
            recordedAt: row.recordedAt,
          },
        ]
      : [],
  );
}
