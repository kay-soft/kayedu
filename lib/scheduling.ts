/**
 * Pure scheduling primitives — time overlap, teacher/room conflict detection,
 * a class period's occurrence dates and its validity rule
 * (docs/02-architecture.md §11, docs/00-master-product-spec.md §5
 * "Scheduling").
 *
 * Deliberately free of runtime imports, exactly like lib/money.ts and
 * lib/identity.ts: `npm run check:classes` exercises this module directly,
 * outside the Next.js runtime and without a database.
 */

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

/**
 * R3: a booking occupies a **room set** — its primary room plus any extra
 * rooms combined with it (lib/rooms.ts). `roomIds` is that whole set;
 * when omitted, the set is just `roomId` (the pre-R3 single-room shape, still
 * what a plain fixture passes).
 */
type RoomOccupant = { roomId: string | null; roomIds?: readonly string[] };

export type ExistingScheduleSlot = ScheduleSlot &
  RoomOccupant & {
    classGroupId: string;
    className: string;
    teacherId: string;
  };

/**
 * One double-booking. Beyond `type`/`classGroupId`/`className` (unchanged
 * since M4), R3 carries enough to print the clash in full: which room
 * (`roomId`, room conflicts) or teacher (`teacherId`, teacher conflicts),
 * and the *other* booking's time window — its weekday (`dayOfWeek`, a
 * schedule clash) or date (`date`, "YYYY-MM-DD", a session clash) plus
 * `startTime`/`endTime`. Names are resolved for display by
 * `lib/db/slot-conflicts.ts`'s `describeConflicts`, never here.
 */
export type ScheduleConflict = {
  type: "teacher" | "room";
  classGroupId: string;
  className: string;
  roomId?: string;
  teacherId?: string;
  dayOfWeek?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  /** The clashing session (session conflicts only). */
  sessionId?: string;
};

/** The whole set of rooms a booking occupies (R3). */
export function occupiedRoomIds(occupant: RoomOccupant): string[] {
  if (occupant.roomIds && occupant.roomIds.length > 0) return [...occupant.roomIds];
  return occupant.roomId ? [occupant.roomId] : [];
}

/**
 * The teacher and room clashes between a candidate and one overlapping
 * booking: a teacher conflict when the teacher is the same, and one room
 * conflict per room the two room sets share (primary or extra, either side).
 */
function clashesWith(
  candidate: RoomOccupant & { teacherId: string },
  other: RoomOccupant & { teacherId: string; classGroupId: string; className: string },
  detail: Partial<ScheduleConflict>,
): ScheduleConflict[] {
  const conflicts: ScheduleConflict[] = [];
  if (other.teacherId === candidate.teacherId) {
    conflicts.push({
      type: "teacher",
      classGroupId: other.classGroupId,
      className: other.className,
      teacherId: other.teacherId,
      ...detail,
    });
  }
  const otherRooms = new Set(occupiedRoomIds(other));
  for (const roomId of occupiedRoomIds(candidate)) {
    if (!otherRooms.has(roomId)) continue;
    conflicts.push({
      type: "room",
      classGroupId: other.classGroupId,
      className: other.className,
      roomId,
      ...detail,
    });
  }
  return conflicts;
}

/**
 * Which of `existing`'s slots the candidate would double-book — same day,
 * overlapping time (half-open: one ending exactly when the other starts is
 * free), and either the same teacher or a shared room (R3: any room of
 * either side's room set). `existing` should already exclude the candidate's
 * own class's other slots.
 *
 * R4: no writer checks weekly slots any more. A class's sessions now exist
 * for its whole period, so every class write checks the real dated sessions
 * it would create (`findSessionConflicts`) — which also knows that two
 * classes on the same weekday slot with non-overlapping periods do not
 * clash, something a weekday comparison cannot see. This stays as the pure
 * weekday primitive `npm run check:classes` exercises.
 */
export function findScheduleConflicts(
  candidate: ScheduleSlot & RoomOccupant & { teacherId: string },
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
    conflicts.push(
      ...clashesWith(candidate, slot, {
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
      }),
    );
  }
  return conflicts;
}

// ── Class-period occurrence dates (lib/db/class-sessions.ts) ───────────────

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

/** The UTC-midnight day marker for a "YYYY-MM-DD" key (Session.date's shape). */
export function dayMarker(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

/**
 * Every calendar date in `[windowStart, windowEnd]` (inclusive) that falls on
 * `schedule.dayOfWeek`, skipping any date whose key is in `holidayKeys`.
 * Pure date math — `windowStart`/`windowEnd` should already be UTC-midnight
 * (docs/01-data-model.md §6 rounding-style rule: normalize once, at the edge).
 * Since R4 the window is a class's period clipped to "from today"; there is
 * no rolling window any more (docs/02 §11).
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

// ── Class period (R4, docs/00 §5.1 "Class periods and centre terms") ───────

/**
 * The longest period a class may span: endDate − startDate, in days. A
 * school year plus a margin — long enough for "Full year", short enough that
 * a typo (2207 for 2027) is refused instead of materializing a decade.
 */
export const MAX_CLASS_PERIOD_DAYS = 400;

export type ClassPeriodError = "endBeforeStart" | "periodTooLong";

/** Whole days from `start` to `end` (both UTC-midnight markers). */
export function daysBetween(start: Date, end: Date): number {
  return Math.round((startOfUtcDay(end).getTime() - startOfUtcDay(start).getTime()) / 86_400_000);
}

/**
 * The one rule for a class's period (and a term's, which only fills one):
 * the end is on or after the start, and the span is at most
 * `MAX_CLASS_PERIOD_DAYS`. `null` = valid. zod, the data layer and the term
 * writer all call this — there is no second copy of the rule.
 */
export function classPeriodError(
  startDate: Date,
  endDate: Date,
  maxDays: number | null = MAX_CLASS_PERIOD_DAYS,
): ClassPeriodError | null {
  const span = daysBetween(startDate, endDate);
  if (span < 0) return "endBeforeStart";
  if (maxDays !== null && span > maxDays) return "periodTooLong";
  return null;
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
 *
 * @deprecated Analytics/Expenses moved to the shared date filter (M18,
 * `resolveSharedDateFilter` below) — kept only because `weekRangeUtc`/
 * `monthRangeUtc` (real calendar week/month) are still used by the teacher
 * dashboard's own KPIs, which this function composed. Do not wire this up to
 * a new screen.
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

// ── The shared date filter (M18, docs/04-design-system.md §11.7) ──────────
//
// One component for every screen: Day / Week (today −7) / Month (1st of the
// current month → today) — always anchored to the real "now", never a
// stored anchor date — plus a specific-date pick and a custom range. This is
// deliberately NOT `weekRangeUtc`/`monthRangeUtc` above: those are real
// calendar-week/calendar-month windows (still used by the teacher dashboard's
// KPIs), while "Week"/"Month" here are trailing windows ending today, per the
// design system's literal definition.

/** The last `days` days up to and including `now`. */
export function lastNDaysUtc(now: Date, days: number): { start: Date; end: Date } {
  const end = startOfUtcDay(now);
  return { start: addDays(end, -days), end };
}

/** The 1st of `now`'s month through `now` itself — not the full calendar month. */
export function monthToDateUtc(now: Date): { start: Date; end: Date } {
  const end = startOfUtcDay(now);
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  return { start, end };
}

export type SharedDateFilterKind = "day" | "week" | "month" | "date" | "range";

export type SharedDateFilterInput = {
  kind: SharedDateFilterKind;
  /** The picked day — only meaningful for `kind === "date"`. */
  date: Date | null;
  /** Only meaningful for `kind === "range"`. */
  from: Date | null;
  to: Date | null;
};

/**
 * Resolves the shared date filter to a `[start, end]` UTC-midnight bound.
 * Always returns real bounds — there is no "all-time" mode here (§11.7 never
 * lists one; a custom range is the closest equivalent, and the visibility
 * window (M19) is the actual mechanism for "how far back can this role see").
 */
export function resolveSharedDateFilter(
  filter: SharedDateFilterInput,
  now: Date = new Date(),
): { start: Date; end: Date } {
  switch (filter.kind) {
    case "day": {
      const day = startOfUtcDay(now);
      return { start: day, end: day };
    }
    case "week":
      return lastNDaysUtc(now, 7);
    case "month":
      return monthToDateUtc(now);
    case "date": {
      const day = startOfUtcDay(filter.date ?? now);
      return { start: day, end: day };
    }
    case "range": {
      const a = startOfUtcDay(filter.from ?? filter.to ?? now);
      const b = startOfUtcDay(filter.to ?? filter.from ?? now);
      return a.getTime() <= b.getTime() ? { start: a, end: b } : { start: b, end: a };
    }
  }
}

// ── Session conflicts (every dated slot write) ─────────────────────────────

export type ExistingSession = RoomOccupant & {
  /** Optional so a pure fixture can omit it; every DB loader sets it. */
  sessionId?: string;
  classGroupId: string;
  className: string;
  teacherId: string;
  date: Date;
  startTime: string;
  endTime: string;
};

export type SessionCandidate = Omit<ExistingSession, "className" | "sessionId">;

/**
 * Same shape as `findScheduleConflicts`, but keyed on a specific calendar date
 * rather than a recurring day-of-week — this is what the class-sessions
 * engine checks for every session it would create or re-room across a
 * class's whole period (R4), and what every other slot-writing path checks
 * too (reschedule, NEW_SESSION approval, a session's own room change). R3: a room is busy when it is the primary
 * **or an extra** of an overlapping session, in either direction. Which
 * sessions occupy anything at all (not CANCELLED, not the original slot of a
 * RESCHEDULED session; closed sessions do) is decided by the loader,
 * `lib/db/slot-conflicts.ts`'s `loadSessionOccupancy`.
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
    conflicts.push(
      ...clashesWith(candidate, session, {
        date: candidateKey,
        startTime: session.startTime,
        endTime: session.endTime,
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      }),
    );
  }
  return conflicts;
}

// ── The confirmation contract (R3, docs/02 §11 "confirmConflicts") ─────────

export type ConflictPolicyValue = "WARN" | "DENY";

/**
 * What a slot-writing action does with the conflicts it found:
 * - `proceed` — no conflicts, or WARN with the double-booking explicitly
 *   confirmed (`confirmConflicts`), which the writer audits;
 * - `needsConfirmation` — WARN, conflicts, no confirmation: refuse and
 *   return the list so the form can show it with a confirm checkbox;
 * - `denied` — DENY: refused whatever the flag says.
 */
export type ConflictDecision = "proceed" | "needsConfirmation" | "denied";

export function decideConflicts(
  conflictCount: number,
  policy: ConflictPolicyValue,
  confirmConflicts: boolean,
): ConflictDecision {
  if (conflictCount === 0) return "proceed";
  if (policy === "DENY") return "denied";
  return confirmConflicts ? "proceed" : "needsConfirmation";
}

/**
 * A conflict ready to print (`SlotConflictNotice`): names resolved, the
 * other booking's window attached. `date` is set for a session clash,
 * `dayOfWeek` for a weekly-slot clash.
 */
export type SlotConflictInfo = {
  type: "teacher" | "room";
  className: string;
  roomName: string | null;
  teacherName: string | null;
  date: string | null;
  dayOfWeek: number | null;
  startTime: string | null;
  endTime: string | null;
};

// ── Centre-timezone clock (R2, docs/02-architecture.md §11 "Session lifecycle") ─
// A `Session` stores its calendar day as a UTC-midnight marker (`date`) and
// its times as bare "HH:MM" wall-clock strings in the centre's own timezone
// (`CenterSettings.timezone`). Everything that compares "now" against a
// session — is it live, has its day ended, is this check-in late — reads the
// current instant through `zonedClock` so the comparison happens in that
// timezone, never in the server's or in UTC. `now` is always a parameter, so
// the gate can inject one.

/** The timezone every centre is created with (lib/db/platform.ts). */
export const DEFAULT_TIMEZONE = "Africa/Cairo";

function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    // `CenterSettings.timezone` is free text — an unknown zone must not take
    // the whole session lifecycle down, so it falls back to the default.
    return DEFAULT_TIMEZONE;
  }
}

/** Wall-clock parts of `instant` in `timeZone`. */
function zonedParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * "What day and minute is it at the centre right now?" — the calendar-day key
 * (same shape as `dateKey`) and minutes since local midnight.
 */
export function zonedClock(now: Date, timeZone: string): { dayKey: string; minutes: number } {
  const p = zonedParts(now, timeZone);
  const dayKey = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return { dayKey, minutes: p.hour * 60 + p.minute };
}

/**
 * The UTC instant of a wall-clock moment (`dayKey` + `minutes` after local
 * midnight) in `timeZone`. Two passes, so a DST shift between the guess and
 * the answer still resolves to the right offset.
 */
export function zonedDateTimeToUtc(dayKey: string, minutes: number, timeZone: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, 0, minutes);
  let guess = wallClockAsUtc;
  for (let pass = 0; pass < 2; pass++) {
    const p = zonedParts(new Date(guess), timeZone);
    const shownAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = guess - (shownAsUtc - wallClockAsUtc);
  }
  return new Date(guess);
}

/** True once the session's calendar day has ended in the centre's timezone. */
export function isSessionDayOver(sessionDate: Date, now: Date, timeZone: string): boolean {
  return zonedClock(now, timeZone).dayKey > dateKey(sessionDate);
}

/**
 * The instant a session's day ends at the centre — local midnight after it.
 * This is what an automatic close stamps as `closedAt`: "closed at the end of
 * the day", whenever the next touch actually happened.
 */
export function endOfSessionDay(sessionDate: Date, timeZone: string): Date {
  return zonedDateTimeToUtc(dateKey(addDays(sessionDate, 1)), 0, timeZone);
}

/** The class's own late threshold, else the centre default, else 10 minutes. */
export function resolveLateThreshold(
  classThreshold: number | null | undefined,
  centerDefault: number | null | undefined,
): number {
  return classThreshold ?? centerDefault ?? 10;
}

/**
 * The one place a check-in's status is decided (R2): PRESENT within
 * `thresholdMinutes` of the session's start (inclusive — exactly on the
 * threshold is still PRESENT), LATE from the minute after. Checking in
 * before the session's day counts as on time; any time on a later day is
 * late. Compared in the centre's timezone, at minute precision.
 */
export function checkInStatus(
  session: { date: Date; startTime: string },
  thresholdMinutes: number,
  now: Date,
  timeZone: string,
): "PRESENT" | "LATE" {
  const clock = zonedClock(now, timeZone);
  const sessionDay = dateKey(session.date);
  if (clock.dayKey < sessionDay) return "PRESENT";
  if (clock.dayKey > sessionDay) return "LATE";
  return clock.minutes > parseTimeToMinutes(session.startTime) + thresholdMinutes
    ? "LATE"
    : "PRESENT";
}
