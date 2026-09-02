/**
 * Pure scheduling primitives — time overlap, teacher/room conflict detection,
 * and rolling-window occurrence generation (docs/02-architecture.md §11,
 * docs/00-master-product-spec.md §5 "Scheduling").
 *
 * Deliberately free of runtime imports, exactly like lib/money.ts and
 * lib/identity.ts: `npm run check:classes` exercises this module directly,
 * outside the Next.js runtime and without a database.
 */

/** How far ahead the generator materializes sessions (docs/02 §11: "~6 weeks"). */
export const GENERATION_WINDOW_DAYS = 42;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "16:00" → 960 (minutes since midnight). Throws on a malformed value. */
export function parseTimeToMinutes(value: string): number {
  const match = TIME_RE.exec(value);
  if (!match) throw new Error(`Invalid time "${value}" — expected "HH:MM".`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

/** A slot must end after it starts — a zero/negative-length slot is invalid. */
export function isValidTimeRange(startTime: string, endTime: string): boolean {
  if (!isValidTime(startTime) || !isValidTime(endTime)) return false;
  return parseTimeToMinutes(startTime) < parseTimeToMinutes(endTime);
}

/** Half-open interval overlap: [aStart, aEnd) intersects [bStart, bEnd). */
export function timeRangesOverlap(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  const aS = parseTimeToMinutes(aStart);
  const aE = parseTimeToMinutes(aEnd);
  const bS = parseTimeToMinutes(bStart);
  const bE = parseTimeToMinutes(bEnd);
  return aS < bE && bS < aE;
}

// ── Schedule-slot conflicts (class-schedule save time) ─────────────────────

export type ScheduleSlot = {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
};

export type ExistingScheduleSlot = ScheduleSlot & {
  classGroupId: string;
  className: string;
  teacherId: string;
  roomId: string | null;
};

export type ScheduleConflict = {
  type: "teacher" | "room";
  classGroupId: string;
  className: string;
};

/**
 * Which of `existing`'s slots the candidate would double-book — same day,
 * overlapping time, and either the same teacher or the same (non-null) room.
 * `existing` should already exclude the candidate's own class's other slots.
 */
export function findScheduleConflicts(
  candidate: ScheduleSlot & { teacherId: string; roomId: string | null },
  existing: ExistingScheduleSlot[],
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  for (const slot of existing) {
    if (slot.dayOfWeek !== candidate.dayOfWeek) continue;
    if (
      !timeRangesOverlap(
        candidate.startTime,
        candidate.endTime,
        slot.startTime,
        slot.endTime,
      )
    ) {
      continue;
    }
    if (slot.teacherId === candidate.teacherId) {
      conflicts.push({
        type: "teacher",
        classGroupId: slot.classGroupId,
        className: slot.className,
      });
    } else if (
      candidate.roomId !== null &&
      slot.roomId !== null &&
      slot.roomId === candidate.roomId
    ) {
      conflicts.push({
        type: "room",
        classGroupId: slot.classGroupId,
        className: slot.className,
      });
    }
  }
  return conflicts;
}

// ── Rolling-window occurrence generation (session generator) ───────────────

/** UTC calendar-day key, so a date compares by day regardless of time-of-day. */
export function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Midnight UTC of the given date's calendar day. */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Every calendar date in `[windowStart, windowEnd]` (inclusive) that falls on
 * `schedule.dayOfWeek`, skipping any date whose key is in `holidayKeys`.
 * Pure date math — `windowStart`/`windowEnd` should already be UTC-midnight
 * (docs/01-data-model.md §6 rounding-style rule: normalize once, at the edge).
 */
export function generateOccurrenceDates(
  schedule: Pick<ScheduleSlot, "dayOfWeek">,
  windowStart: Date,
  windowEnd: Date,
  holidayKeys: ReadonlySet<string>,
): Date[] {
  const dates: Date[] = [];
  const start = startOfUtcDay(windowStart);
  const end = startOfUtcDay(windowEnd);
  // Advance to the first occurrence of dayOfWeek on/after start.
  const offset = (schedule.dayOfWeek - start.getUTCDay() + 7) % 7;
  let cursor = addDays(start, offset);
  while (cursor.getTime() <= end.getTime()) {
    if (!holidayKeys.has(dateKey(cursor))) dates.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return dates;
}

// ── Date-range windows (Today's Sessions dashboard filters, M5) ────────────

/** Sunday-start week containing `date`, as a `[start, end]` UTC-midnight pair. */
export function weekRangeUtc(date: Date): { start: Date; end: Date } {
  const start = startOfUtcDay(date);
  const offset = start.getUTCDay();
  const weekStart = addDays(start, -offset);
  return { start: weekStart, end: addDays(weekStart, 6) };
}

/** Calendar month containing `date`, as a `[start, end]` UTC-midnight pair. */
export function monthRangeUtc(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { start, end };
}

/** Calendar year containing `date`, as a `[start, end]` UTC-midnight pair (M6 Analytics). */
export function yearRangeUtc(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), 11, 31));
  return { start, end };
}

export type DateRangeKind = "day" | "week" | "month" | "year" | "all";

/**
 * Resolves one of Analytics/Expenses' date-range filters (spec §4.1 items 5
 * & 6) to a `[start, end]` UTC-midnight bound around `anchor` — or `null`
 * bounds for "all-time", which `lib/db/analytics.ts` treats as unbounded
 * rather than a fabricated epoch date.
 */
export function resolveDateRangeUtc(
  kind: DateRangeKind,
  anchor: Date,
): { start: Date | null; end: Date | null } {
  switch (kind) {
    case "day": {
      const day = startOfUtcDay(anchor);
      return { start: day, end: day };
    }
    case "week":
      return weekRangeUtc(anchor);
    case "month":
      return monthRangeUtc(anchor);
    case "year":
      return yearRangeUtc(anchor);
    case "all":
      return { start: null, end: null };
  }
}

// ── Session conflicts (generation time) ────────────────────────────────────

export type ExistingSession = {
  classGroupId: string;
  className: string;
  teacherId: string;
  roomId: string | null;
  date: Date;
  startTime: string;
  endTime: string;
};

export type SessionCandidate = Omit<ExistingSession, "className">;

/**
 * Same shape as `findScheduleConflicts`, but keyed on a specific calendar date
 * rather than a recurring day-of-week — this is what the generator checks
 * right before materializing one `Session` row.
 */
export function findSessionConflicts(
  candidate: SessionCandidate,
  existing: ExistingSession[],
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  const candidateKey = dateKey(candidate.date);
  for (const session of existing) {
    if (session.classGroupId === candidate.classGroupId) continue;
    if (dateKey(session.date) !== candidateKey) continue;
    if (
      !timeRangesOverlap(
        candidate.startTime,
        candidate.endTime,
        session.startTime,
        session.endTime,
      )
    ) {
      continue;
    }
    if (session.teacherId === candidate.teacherId) {
      conflicts.push({
        type: "teacher",
        classGroupId: session.classGroupId,
        className: session.className,
      });
    } else if (
      candidate.roomId !== null &&
      session.roomId !== null &&
      session.roomId === candidate.roomId
    ) {
      conflicts.push({
        type: "room",
        classGroupId: session.classGroupId,
        className: session.className,
      });
    }
  }
  return conflicts;
}
