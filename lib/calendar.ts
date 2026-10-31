// Relative imports on purpose — `check:student-portal` and `check:teacher-portal`
// exercise these rules directly, outside the Next.js runtime.
import { addDays, dateKey } from "./scheduling.ts";

/**
 * The month calendar's rules (U7, docs/04-design-system.md §11.28): its URL
 * state, its grid, and what each session's status is called and coloured.
 * Pure — no clock, no database: "today" comes in as a day marker resolved by
 * the caller in the right timezone (R7b), like every other range helper.
 */

/**
 * Every status a calendar shows. Student and parent: what happened at a past
 * session (Present / Late / Absent — enrolled only; a drop-in who never came
 * shows nothing), an enrolled session ahead (Upcoming), a single session
 * booked or asked for (Booked / Requested), a cancelled one. Teacher: a
 * session held (closed), ahead, or cancelled. A moved (RESCHEDULED) original
 * is never one of them (U2) — its replacement is.
 */
export type CalendarTone =
  | "present"
  | "late"
  | "absent"
  | "upcoming"
  | "booked"
  | "requested"
  | "cancelled"
  | "held";

export const STUDENT_CALENDAR_TONES: CalendarTone[] = [
  "present",
  "late",
  "absent",
  "upcoming",
  "booked",
  "requested",
  "cancelled",
];
export const TEACHER_CALENDAR_TONES: CalendarTone[] = ["held", "upcoming", "cancelled"];

/** At most this many dots in a day cell; the rest read "+n". */
export const CALENDAR_DOTS = 3;

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** "YYYY-MM" for the month containing `day`. */
export function monthKey(day: Date): string {
  return dateKey(day).slice(0, 7);
}

/** The first of the month as a UTC-midnight day marker. */
export function monthStart(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
}

/** `?month=YYYY-MM`, or the month of `today` when absent or malformed. */
export function parseCalendarMonth(raw: string | null | undefined, today: Date): Date {
  const match = raw ? MONTH_KEY.exec(raw.trim()) : null;
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)) : monthStart(today);
}

/** The month a step away — `-1` previous, `1` next. */
export function shiftMonth(month: Date, by: number): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + by, 1));
}

/** The month's first and last day, as the `[start, end]` a range read takes. */
export function calendarMonthRange(month: Date): { start: Date; end: Date } {
  const start = monthStart(month);
  return { start, end: addDays(shiftMonth(start, 1), -1) };
}

/**
 * The selected day: `?day=` when it is a real day inside the month shown,
 * else today when today is in that month, else none (the list asks for a tap).
 */
export function parseCalendarDay(raw: string | null | undefined, month: Date, today: Date): string | null {
  const key = raw?.trim() ?? "";
  if (DAY_KEY.test(key) && key.startsWith(monthKey(month)) && dateKey(new Date(`${key}T00:00:00.000Z`)) === key) {
    return key;
  }
  return monthKey(today) === monthKey(month) ? dateKey(today) : null;
}

/**
 * The grid's days: whole weeks from the week holding the 1st to the week
 * holding the last day, opening on `weekStart` (0 Sunday … 6 Saturday — the
 * app's own rule, `calendarWeekStart`).
 */
export function calendarGrid(month: Date, weekStart: number): Date[] {
  const { start, end } = calendarMonthRange(month);
  const lead = (start.getUTCDay() - weekStart + 7) % 7;
  const trail = (weekStart + 6 - end.getUTCDay() + 7) % 7;
  const origin = addDays(start, -lead);
  const length = lead + end.getUTCDate() + trail;
  return Array.from({ length }, (_, index) => addDays(origin, index));
}

/** A teacher's session on the calendar: held once closed, cancelled, else upcoming. */
export function teacherCalendarTone(session: { status: string; closedAt: Date | null }): CalendarTone {
  if (session.status === "CANCELLED") return "cancelled";
  return session.closedAt ? "held" : "upcoming";
}
