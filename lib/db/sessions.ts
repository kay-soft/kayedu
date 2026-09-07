import type {
  ConflictPolicy,
  Prisma,
  PrismaClient,
  Session,
  SessionStatus,
  ShareType,
} from "@prisma/client";

// Relative imports on purpose: `npm run check:classes` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/students.ts
// and lib/db/tenant-scope.ts). The Prisma client is *injected* rather than
// imported from lib/db/client.ts for the same reason — the gate script
// constructs its own `PrismaClient()`, the app passes the shared singleton.
import { scopedData, scopedWhere } from "./tenant-scope.ts";
import { catalogLabel } from "../catalog.ts";
import {
  GENERATION_WINDOW_DAYS,
  addDays,
  findSessionConflicts,
  generateOccurrenceDates,
  startOfUtcDay,
  type ExistingSession,
  type ScheduleConflict,
} from "../scheduling.ts";

/**
 * The session generator (docs/02-architecture.md §11, spec §5 "Scheduling"):
 * materializes `Session` rows from `ClassSchedule` on a rolling window,
 * snapshotting the class price, skipping the holiday calendar, and detecting
 * teacher/room conflicts against every other class in the center.
 *
 * Regeneration is idempotent: `Session` is unique on
 * `(classGroupId, date, startTime)`, so a `createMany({ skipDuplicates: true })`
 * against that key never duplicates a session a previous run already created —
 * running this twice in a row creates zero new rows the second time.
 */

export type GenerationConflict = ScheduleConflict & { date: string };

export type GenerateSessionsResult = {
  created: number;
  conflicts: GenerationConflict[];
};

type ClassForGeneration = {
  id: string;
  teacherId: string;
  roomId: string | null;
  price: number;
  schedules: { dayOfWeek: number; startTime: string; endTime: string }[];
  className: string;
};

/** The class fields the generator needs, loaded once per run. */
async function loadClassesForGeneration(
  db: PrismaClient,
  centerId: string,
  locale: string,
  classGroupId?: string,
): Promise<ClassForGeneration[]> {
  const rows = await db.classGroup.findMany({
    where: scopedWhere(centerId, {
      active: true,
      ...(classGroupId ? { id: classGroupId } : {}),
    }),
    select: {
      id: true,
      teacherId: true,
      roomId: true,
      price: true,
      schedules: {
        select: { dayOfWeek: true, startTime: true, endTime: true },
      },
      subject: { select: { nameAr: true, nameEn: true } },
      grade: { select: { nameAr: true, nameEn: true } },
    },
  });

  return rows
    .filter((row) => row.schedules.length > 0)
    .map((row) => ({
      id: row.id,
      teacherId: row.teacherId,
      roomId: row.roomId,
      price: row.price,
      schedules: row.schedules,
      className:
        [
          row.subject ? catalogLabel(locale, row.subject) : null,
          row.grade ? catalogLabel(locale, row.grade) : null,
        ]
          .filter(Boolean)
          .join(" · ") || "—",
    }));
}

/** Every existing, non-cancelled session in the window — the conflict universe. */
const CANCELLED: SessionStatus = "CANCELLED";

async function loadExistingSessions(
  db: PrismaClient,
  centerId: string,
  locale: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ExistingSession[]> {
  const rows = await db.session.findMany({
    where: scopedWhere(centerId, {
      date: { gte: windowStart, lte: windowEnd },
      status: { not: CANCELLED },
    }),
    select: {
      classGroupId: true,
      teacherId: true,
      roomId: true,
      date: true,
      startTime: true,
      endTime: true,
      classGroup: {
        select: {
          subject: { select: { nameAr: true, nameEn: true } },
          grade: { select: { nameAr: true, nameEn: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    classGroupId: row.classGroupId,
    teacherId: row.teacherId,
    roomId: row.roomId,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    className:
      [
        row.classGroup.subject ? catalogLabel(locale, row.classGroup.subject) : null,
        row.classGroup.grade ? catalogLabel(locale, row.classGroup.grade) : null,
      ]
        .filter(Boolean)
        .join(" · ") || "—",
  }));
}

async function loadHolidayKeys(
  db: PrismaClient,
  centerId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Set<string>> {
  const rows = await db.holiday.findMany({
    where: scopedWhere(centerId, { date: { gte: windowStart, lte: windowEnd } }),
    select: { date: true },
  });
  return new Set(rows.map((row) => row.date.toISOString().slice(0, 10)));
}

/**
 * Generates sessions for one class (or, when `classGroupId` is omitted, every
 * active class in the center) across the rolling window starting today.
 * Conflicting occurrences are skipped under `DENY` and created-but-flagged
 * under `WARN` — either way, the caller gets back what happened so the UI can
 * show it.
 */
export async function generateSessions(
  db: PrismaClient,
  centerId: string,
  conflictPolicy: ConflictPolicy,
  classGroupId?: string,
  // Only used to label a conflict for display (`GenerationConflict.className`)
  // — the cron-triggered path (`app/api/cron/generate-sessions/route.ts`) has
  // no user/locale to thread through, so it stays on this neutral default.
  locale = "en",
): Promise<GenerateSessionsResult> {
  const windowStart = startOfUtcDay(new Date());
  // generateOccurrenceDates treats both ends inclusively (its own doc-comment
  // contract, `lib/scheduling.ts`), so a window of GENERATION_WINDOW_DAYS
  // calendar days is [windowStart, windowStart + (GENERATION_WINDOW_DAYS - 1)]
  // — 42 distinct days, not 43. Off-by-one here previously made the window
  // inclusive of a 43rd day, which silently added a bonus 7th occurrence of
  // whichever weekday happened to equal "today"'s weekday on the day the
  // generator ran — a date-dependent bug, not just a date-dependent test.
  const windowEnd = addDays(windowStart, GENERATION_WINDOW_DAYS - 1);

  const [classes, holidayKeys, existing] = await Promise.all([
    loadClassesForGeneration(db, centerId, locale, classGroupId),
    loadHolidayKeys(db, centerId, windowStart, windowEnd),
    loadExistingSessions(db, centerId, locale, windowStart, windowEnd),
  ]);

  // Accumulates as we go, so two classes generated in the same run still see
  // each other's freshly-created occurrences when checking for conflicts.
  const known = [...existing];
  const conflicts: GenerationConflict[] = [];
  const toInsert: {
    classGroupId: string;
    teacherId: string;
    roomId: string | null;
    date: Date;
    startTime: string;
    endTime: string;
    priceSnapshot: number;
  }[] = [];

  for (const classGroup of classes) {
    for (const schedule of classGroup.schedules) {
      const dates = generateOccurrenceDates(
        schedule,
        windowStart,
        windowEnd,
        holidayKeys,
      );

      for (const date of dates) {
        const candidate = {
          classGroupId: classGroup.id,
          teacherId: classGroup.teacherId,
          roomId: classGroup.roomId,
          date,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
        };

        const found = findSessionConflicts(candidate, known);
        if (found.length > 0) {
          for (const conflict of found) {
            conflicts.push({ ...conflict, date: date.toISOString().slice(0, 10) });
          }
          if (conflictPolicy === "DENY") continue;
        }

        toInsert.push({
          classGroupId: classGroup.id,
          teacherId: classGroup.teacherId,
          roomId: classGroup.roomId,
          date,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          priceSnapshot: classGroup.price,
        });
        known.push({
          classGroupId: classGroup.id,
          teacherId: classGroup.teacherId,
          roomId: classGroup.roomId,
          date,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          className: classGroup.className,
        });
      }
    }
  }

  if (toInsert.length === 0) return { created: 0, conflicts };

  const result = await db.session.createMany({
    data: toInsert.map((row) => scopedData(centerId, row)),
    skipDuplicates: true,
  });

  return { created: result.count, conflicts };
}

// ─────────────────────────────────────────────────────────────────────────
// Session lifecycle: cancel / reschedule (M10, spec §7 acceptance criterion
// 11, closing the gap flagged since M5/docs §11: "Cancel/reschedule/edit of
// an individual session is not yet built"). Kept in this file beside the
// generator, for the same "no @/ imports" reason the rest of this module is
// written that way (docs/02 §5).
// ─────────────────────────────────────────────────────────────────────────

type SessionDb = PrismaClient | Prisma.TransactionClient;

const CANCELLED_ENUM: SessionStatus = "CANCELLED";

export type CancelSessionResult =
  | { ok: true; session: Session }
  | { ok: false; error: "notFound" | "alreadyCancelled" };

/**
 * Cancels one session. Money is never touched here (CLAUDE.md rule 2) — a
 * cancelled session's existing attendance/payment rows stay exactly as
 * recorded; if a payment needs undoing, that is `voidPayment`'s job, a
 * separate, explicit, audited action. "Roster and schedule update
 * correctly" (spec §7 criterion 11) is true by construction: `SessionAttendee`
 * rows are never deleted, and `deriveSessionDisplayStatus` already treats
 * `CANCELLED` as terminal regardless of the clock.
 */
export async function cancelSession(
  db: SessionDb,
  centerId: string,
  sessionId: string,
): Promise<CancelSessionResult> {
  const session = await db.session.findFirst({ where: { centerId, id: sessionId } });
  if (!session) return { ok: false, error: "notFound" };
  if (session.status === CANCELLED_ENUM) return { ok: false, error: "alreadyCancelled" };

  const updated = await db.session.update({
    where: { id: sessionId },
    data: { status: CANCELLED_ENUM },
  });
  return { ok: true, session: updated };
}

export type UpdateSessionShareOverrideResult =
  | { ok: true; session: Session }
  | { ok: false; error: "notFound" };

/**
 * Sets or clears this one session's centre-cut override (M13, spec §5.1
 * "Center cut" — "overridable per class and per session"). `null` clears the
 * override back to "inherit the class's own centerShareType/
 * centerShareValue" — every session's state until this is called. Only
 * consulted by `recordPayment` at the moment a payment is frozen; never
 * touches an already-recorded payment's snapshots (CLAUDE.md rule 2).
 */
export async function updateSessionShareOverride(
  db: SessionDb,
  centerId: string,
  sessionId: string,
  override: { centerShareType: ShareType; centerShareValue: number } | null,
): Promise<UpdateSessionShareOverrideResult> {
  const session = await db.session.findFirst({ where: { centerId, id: sessionId } });
  if (!session) return { ok: false, error: "notFound" };

  const updated = await db.session.update({
    where: { id: sessionId },
    data: {
      centerShareType: override?.centerShareType ?? null,
      centerShareValue: override?.centerShareValue ?? null,
    },
  });
  return { ok: true, session: updated };
}

export type RescheduleSessionResult =
  | { ok: true; session: Session; conflicts: GenerationConflict[] }
  | { ok: false; error: "notFound" | "cancelled" | "conflict" | "duplicateSlot" };

/**
 * Moves one session to a new date/time, re-running the same teacher/room
 * conflict check the generator itself uses (`findSessionConflicts`, docs/02
 * §11) against every other class's sessions on the target date — WARN saves
 * it flagged, DENY refuses. `findSessionConflicts` already skips a session's
 * own class (`session.classGroupId === candidate.classGroupId`), so the
 * session being moved never "conflicts with itself".
 *
 * The `(classGroupId, date, startTime)` unique constraint still applies — if
 * this class already has another session at the target slot, the write
 * fails with `duplicateSlot` rather than silently merging two sessions.
 */
export async function rescheduleSession(
  db: SessionDb,
  centerId: string,
  sessionId: string,
  next: { date: Date; startTime: string; endTime: string },
  conflictPolicy: ConflictPolicy,
): Promise<RescheduleSessionResult> {
  const session = await db.session.findFirst({ where: { centerId, id: sessionId } });
  if (!session) return { ok: false, error: "notFound" };
  if (session.status === CANCELLED_ENUM) return { ok: false, error: "cancelled" };

  const existing = await loadExistingSessions(
    db as PrismaClient,
    centerId,
    startOfUtcDay(next.date),
    startOfUtcDay(next.date),
  );

  const found = findSessionConflicts(
    {
      classGroupId: session.classGroupId,
      teacherId: session.teacherId,
      roomId: session.roomId,
      date: next.date,
      startTime: next.startTime,
      endTime: next.endTime,
    },
    existing,
  );
  const conflicts: GenerationConflict[] = found.map((conflict) => ({
    ...conflict,
    date: next.date.toISOString().slice(0, 10),
  }));

  if (conflicts.length > 0 && conflictPolicy === "DENY") {
    return { ok: false, error: "conflict" };
  }

  try {
    const updated = await db.session.update({
      where: { id: sessionId },
      data: { date: next.date, startTime: next.startTime, endTime: next.endTime },
    });
    return { ok: true, session: updated, conflicts };
  } catch (error) {
    if (
      error instanceof Object &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { ok: false, error: "duplicateSlot" };
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Read-side session policy (Today's Sessions dashboard + detail, M5).
// Kept in this file — not lib/db/classes.ts or lib/db/scoped.ts — because
// `npm run check:classes` already imports this module directly outside the
// Next.js runtime for `generateSessions`, so everything here stays free of
// `@/` aliases the same way (docs/02-architecture.md §5).
// ─────────────────────────────────────────────────────────────────────────

const CANCELLED_STATUS: SessionStatus = "CANCELLED";
const ACTIVE_ENROLLMENT_STATUS = "ACTIVE" as const;

/** Fields a Today's Sessions dashboard row renders — never a full include. */
export const SESSION_LIST_SELECT = {
  id: true,
  date: true,
  startTime: true,
  endTime: true,
  status: true,
  priceSnapshot: true,
  teacherId: true,
  classGroupId: true,
  classGroup: {
    select: {
      subject: { select: { nameAr: true, nameEn: true } },
      grade: { select: { nameAr: true, nameEn: true } },
      _count: { select: { enrollments: { where: { status: ACTIVE_ENROLLMENT_STATUS } } } },
    },
  },
  room: { select: { id: true, name: true } },
  _count: { select: { attendees: true } },
} satisfies Prisma.SessionSelect;

export type SessionListRow = Prisma.SessionGetPayload<{
  select: typeof SESSION_LIST_SELECT;
}>;

/** A session detail page — every field it renders, including the roster. */
export const SESSION_DETAIL_INCLUDE = {
  teacher: true,
  room: true,
  classGroup: { include: { subject: true, grade: true } },
  attendees: {
    include: {
      studentProfile: { include: { user: true } },
      enrollment: true,
      payments: { orderBy: { recordedAt: "desc" } },
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.SessionInclude;

export type SessionDetailRow = Prisma.SessionGetPayload<{
  include: typeof SESSION_DETAIL_INCLUDE;
}>;

export function sessionListWhere(filters: {
  from: Date;
  to: Date;
  teacherId?: string | null;
  subjectId?: string | null;
  classGroupId?: string | null;
}): Prisma.SessionWhereInput {
  const where: Prisma.SessionWhereInput = {
    date: { gte: filters.from, lte: filters.to },
  };
  if (filters.teacherId) where.teacherId = filters.teacherId;
  if (filters.classGroupId) where.classGroupId = filters.classGroupId;
  if (filters.subjectId) where.classGroup = { subjectId: filters.subjectId };
  return where;
}

export type SessionDisplayStatus = "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";

/**
 * SCHEDULED/LIVE/COMPLETED are derived from the clock, not stored — nothing
 * in this codebase transitions `Session.status` between them yet (docs/02
 * §11 leaves session lifecycle writes, cancel included, to a later
 * milestone). CANCELLED is the one persisted value this passes through.
 *
 * Consistent with `generateOccurrenceDates`/`startOfUtcDay` elsewhere in this
 * file: `date` is a pure UTC-midnight calendar-day marker and `startTime`/
 * `endTime` are plain "HH:MM" wall-clock strings, compared here against the
 * server's current UTC clock with no timezone conversion — the same
 * simplification the M4 generator already makes (Phase 1 is Egypt-only, one
 * timezone, per spec §1).
 */
export function deriveSessionDisplayStatus(
  session: { status: SessionStatus; date: Date; startTime: string; endTime: string },
  now: Date,
): SessionDisplayStatus {
  if (session.status === CANCELLED_STATUS) return "CANCELLED";

  const dayKey = session.date.toISOString().slice(0, 10);
  const nowKey = now.toISOString().slice(0, 10);
  if (dayKey > nowKey) return "SCHEDULED";
  if (dayKey < nowKey) return "COMPLETED";

  const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = parseTimeToMinutesSafe(session.startTime);
  const endMinutes = parseTimeToMinutesSafe(session.endTime);
  if (nowMinutes < startMinutes) return "SCHEDULED";
  if (nowMinutes >= endMinutes) return "COMPLETED";
  return "LIVE";
}

function parseTimeToMinutesSafe(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

/** A short label for the session in a list/receipt ("Math · Grade 10"). */
export function sessionDisplayName(
  locale: string,
  row: {
    classGroup: {
      subject: { nameAr: string; nameEn: string } | null;
      grade: { nameAr: string; nameEn: string } | null;
    };
  },
): string {
  return (
    [
      row.classGroup.subject ? catalogLabel(locale, row.classGroup.subject) : null,
      row.classGroup.grade ? catalogLabel(locale, row.classGroup.grade) : null,
    ]
      .filter(Boolean)
      .join(" · ") || "—"
  );
}
