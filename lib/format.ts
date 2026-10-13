import { fromPiastres } from "@/lib/money";

/**
 * Numeral convention (docs/02 §8, docs/04 §3): Arabic-Indic digits in `ar`,
 * Latin digits in `en`. Never mix within a locale — always format through here.
 */
const NUMBER_LOCALE: Record<string, string> = {
  ar: "ar-EG-u-nu-arab",
  en: "en-US",
};

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? "en-US").format(value);
}

/** A whole number padded to two digits — "05", "٠٥" — for minute lists. */
export function formatTwoDigits(value: number, locale: string): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    minimumIntegerDigits: 2,
    useGrouping: false,
  }).format(value);
}

export function formatDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    dateStyle: "medium",
  }).format(value);
}

/**
 * A calendar day stored as a UTC-midnight marker (`Session.date`,
 * `ClassGroup.startDate`/`endDate`, a term's dates — R4). Formatted in UTC so
 * the stored day is the day shown, whatever timezone the server or the
 * browser runs in.
 */
export function formatDay(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(value);
}

/** A class period or a term: "9 Oct 2026 – 1 Apr 2027", day markers in UTC. */
export function formatDayRange(start: Date, end: Date, locale: string): string {
  const format = new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  return normalizeSpaces(format.formatRange(start, end));
}

/**
 * A real instant — when a session was closed, when an attendance change was
 * made (R2) — rendered as date + 12-hour time **in the centre's timezone**,
 * so "closed at 6:05 PM" reads the same on any server or browser. Distinct
 * from `formatTime`, which renders a bare stored "HH:MM" wall-clock string.
 */
export function formatDateTime(value: Date, locale: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true,
    timeZone,
  };
  try {
    return normalizeSpaces(
      new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", options).format(value),
    );
  } catch {
    // An unknown free-text `CenterSettings.timezone` falls back to Cairo,
    // the default every centre is created with.
    return normalizeSpaces(
      new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
        ...options,
        timeZone: "Africa/Cairo",
      }).format(value),
    );
  }
}

/**
 * A real instant as a 12-hour clock time alone ("4:05 PM") **in the centre's
 * timezone** — "already checked in at 4:05 PM" on the reception desk (R7).
 * The date-less sibling of `formatDateTime`.
 */
export function formatClockTime(value: Date, locale: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { timeStyle: "short", hour12: true, timeZone };
  try {
    return normalizeSpaces(
      new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", options).format(value),
    );
  } catch {
    return normalizeSpaces(
      new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
        ...options,
        timeZone: "Africa/Cairo",
      }).format(value),
    );
  }
}

/**
 * A teacher's published rating (M17, docs/00-master-product-spec.md §5
 * "Teacher ratings") — always the average alone, out of 5, never a count
 * alongside it.
 */
export function formatRating(average: number, locale: string): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(average);
}

/**
 * Money display. Takes **piastres** (never EGP) so callers can't accidentally
 * format a raw float — conversion lives in lib/money.ts.
 */
export function formatMoney(piastres: number, locale: string): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    style: "currency",
    currency: "EGP",
    minimumFractionDigits: piastres % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(fromPiastres(piastres));
}

/**
 * Calendar chrome (docs/04-design-system.md §5 "Date control"). The month
 * heading, the weekday initials and the day numbers all render through here
 * for the same reason every other figure does: Arabic-Indic digits in `ar`,
 * Latin in `en`, and never a mix (docs/02 §8).
 */
export function formatMonthYear(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

/** The single-letter column heading for a weekday, e.g. "M" / "ن". */
export function formatWeekdayNarrow(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    weekday: "narrow",
    timeZone: "UTC",
  }).format(value);
}

/** A bare day-of-month number for a calendar cell. */
export function formatDayOfMonth(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    day: "numeric",
    timeZone: "UTC",
  }).format(value);
}

/** The accessible name of a calendar cell — the full date, spelled out. */
export function formatFullDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    dateStyle: "full",
    timeZone: "UTC",
  }).format(value);
}

/**
 * Wall-clock time display. Takes the `"HH:MM"` strings that `ClassSchedule`
 * and `Session` store (docs/01-data-model.md §2 — a plain wall-clock string,
 * never a timestamp) and renders them in the **12-hour** convention the
 * centres actually speak in: `4:00 PM` / `٤:٠٠ م`, never `16:00`.
 *
 * The string is parsed into a UTC instant and formatted in UTC so no server
 * or browser timezone can shift it — "16:00" is 4 PM in every locale.
 * Anything that isn't a valid `HH:MM` is passed through untouched rather than
 * rendered as "Invalid Date".
 */
function timeToUtcDate(value: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return new Date(Date.UTC(1970, 0, 1, hours, minutes));
}

const timeFormatOptions: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
};

function normalizeSpaces(value: string): string {
  return value.replace(/[\u2009\u202F\u00A0]/g, " ");
}

export function formatTime(value: string, locale: string): string {
  const date = timeToUtcDate(value);
  if (!date) return value;
  return normalizeSpaces(
    new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", timeFormatOptions).format(date),
  );
}

/**
 * A start–end pair as one range. `formatRange` collapses the shared meridiem
 * where the locale does ("4:00 – 5:30 PM") and picks the locale's own range
 * separator, which is why this never hand-joins with an en dash.
 */
export function formatTimeRange(start: string, end: string, locale: string): string {
  const from = timeToUtcDate(start);
  const to = timeToUtcDate(end);
  if (!from || !to) return `${formatTime(start, locale)}–${formatTime(end, locale)}`;
  return normalizeSpaces(
    new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", timeFormatOptions).formatRange(
      from,
      to,
    ),
  );
}

