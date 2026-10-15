import { toAsciiDigits } from "./digits.ts";
import { parseTimeToMinutes } from "./scheduling.ts";

/**
 * The ONE parser for a typed time of day (R6, docs/04 §11.15). The shared
 * `TimePicker` is the only caller in the UI; the value it posts is always the
 * stored 24-hour `"HH:mm"` string. Display goes through `lib/format.ts`
 * (`formatTime`) — this module never formats for people, it only reads what
 * they typed and does time arithmetic on the stored string.
 *
 * Accepted (case and surrounding spaces ignored, Arabic-Indic digits folded):
 *   "4"        → a bare hour (see `defaultMeridiem`)
 *   "4pm" "4 PM" "4:30 pm" "4.30p.m." "12am"
 *   "16:30" "04:30" "0:00" "23:59"
 *   "٤:٣٠ م" "٤ ص" "٤ مساءً" — Arabic digits and ص (AM) / م (PM)
 *
 * Anything else is **refused with a reason**, never coerced: "25", "12:60",
 * "13pm", "0am", "4:5", "4:30:10", "abc", "".
 */

export type Meridiem = "AM" | "PM";
export type TimeParseError = "empty" | "invalid" | "outOfRange";
export type TimeParseResult = { ok: true; value: string } | { ok: false; error: TimeParseError };

/** Arabic combining marks (tanwin, fatha, …) — dropped so "مساءً" reads as "مساء". */
const ARABIC_MARKS = /[ً-ٰٟ]/g;

const SUFFIX = /^(.*?)\s*(a\.?\s?m\.?|p\.?\s?m\.?|ص|م|صباحا|مساء)$/u;
const CLOCK = /^(\d{1,2})(?:[:.٫：](\d{2}))?$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `options.defaultMeridiem` decides a **bare 12-hour-looking hour with no
 * AM/PM** ("4", "11", "4:30" — hour 1–12, no leading zero): the picker passes the
 * meridiem of the value being edited so typing "5" over a PM time gives 5 PM.
 * Without it, such an hour is read on the 24-hour clock ("4" = 04:00). An
 * hour that can only be 24-hour (0, 13–23) or is written with a leading zero
 * ("04:30") is always read as 24-hour.
 */
export function parseTimeInput(
  input: string,
  options: { defaultMeridiem?: Meridiem } = {},
): TimeParseResult {
  const text = toAsciiDigits(input).replace(ARABIC_MARKS, "").trim().toLowerCase();
  if (text === "") return { ok: false, error: "empty" };

  let clock = text;
  let meridiem: Meridiem | null = null;
  const suffix = SUFFIX.exec(text);
  if (suffix) {
    clock = suffix[1].trim();
    const word = suffix[2].replace(/[.\s]/g, "");
    meridiem = word === "am" || word === "ص" || word === "صباحا" ? "AM" : "PM";
  }

  const match = CLOCK.exec(clock);
  if (!match) return { ok: false, error: "invalid" };
  const hourText = match[1];
  const hour = Number(hourText);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (minute > 59) return { ok: false, error: "outOfRange" };

  if (meridiem) {
    if (hour < 1 || hour > 12) return { ok: false, error: "outOfRange" };
    return { ok: true, value: fromTimeParts(hour, minute, meridiem) };
  }
  if (hour > 23) return { ok: false, error: "outOfRange" };

  const ambiguous = hour >= 1 && hour <= 12 && !hourText.startsWith("0");
  if (ambiguous && options.defaultMeridiem) {
    return { ok: true, value: fromTimeParts(hour, minute, options.defaultMeridiem) };
  }
  return { ok: true, value: `${pad(hour)}:${pad(minute)}` };
}

/** `"16:30"` → `{ hour12: 4, minute: 30, meridiem: "PM" }`. `null` for a non-time. */
export function timeParts(
  value: string,
): { hour12: number; minute: number; meridiem: Meridiem } | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const minutes = parseTimeToMinutes(value);
  const hour24 = Math.floor(minutes / 60);
  return {
    hour12: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minute: minutes % 60,
    meridiem: hour24 >= 12 ? "PM" : "AM",
  };
}

/** 12-hour parts → `"HH:mm"`. 12 AM is 00:xx, 12 PM is 12:xx. */
export function fromTimeParts(hour12: number, minute: number, meridiem: Meridiem): string {
  const base = hour12 % 12;
  const hour24 = meridiem === "PM" ? base + 12 : base;
  return `${pad(hour24)}:${pad(minute)}`;
}

/** Whole minutes between two stored times (`end - start`, negative when reversed). */
export function minutesBetween(start: string, end: string): number {
  return parseTimeToMinutes(end) - parseTimeToMinutes(start);
}

const LAST_MINUTE = 23 * 60 + 59;
const DEFAULT_DURATION_MINUTES = 60;

/**
 * The end a paired control suggests when a start is chosen: `start` plus the
 * previous duration (or one hour), held inside the day. `null` when no later
 * time exists (a start of 23:59).
 */
export function suggestEndTime(start: string, previousDurationMinutes?: number | null): string | null {
  const from = parseTimeToMinutes(start);
  if (from >= LAST_MINUTE) return null;
  const duration =
    previousDurationMinutes && previousDurationMinutes > 0
      ? previousDurationMinutes
      : DEFAULT_DURATION_MINUTES;
  const end = Math.min(from + duration, LAST_MINUTE);
  return `${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
}
