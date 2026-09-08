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

export function formatDate(value: Date, locale: string): string {
  return new Intl.DateTimeFormat(NUMBER_LOCALE[locale] ?? "en-US", {
    dateStyle: "medium",
  }).format(value);
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
