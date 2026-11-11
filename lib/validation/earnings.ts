import { z } from "zod";

// Relative import on purpose: `npm run check:workspaces` resolves periods
// outside the Next.js runtime.
import { addDays, dateKey, monthRangeUtc } from "../scheduling.ts";

/**
 * The Earnings page's period (W8d, D-W29, D-W41 item 1): the last 7, 30 (the
 * default) or 90 days, this calendar month, or a custom range of at most a
 * year — picked with **the shared date filter** (docs/04 §11.7) and its URL
 * contract (`range`, `date`, `from`, `to`), with the page's own presets in
 * place of Day / Week / Month. A specific day is a one-day custom range.
 * Anything unreadable reads as the default with `invalid` set, so the page
 * can say so. The range is resolved **per source** from that source's own
 * calendar day (R7b), then clamped to the source's window by the caller
 * (`lib/db/teacher-earnings.ts`).
 */
export const EARNINGS_PRESETS = ["7d", "30d", "90d", "month"] as const;
export type EarningsPreset = (typeof EARNINGS_PRESETS)[number];
export const DEFAULT_EARNINGS_PERIOD: EarningsPreset = "30d";
/** The longest custom range, in days (inclusive) — a year and a day, like a settlement period. */
export const MAX_EARNINGS_RANGE_DAYS = 366;

const isoDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && dateKey(new Date(`${value}T00:00:00.000Z`)) === value);

export type EarningsPeriodChoice =
  | { period: EarningsPreset; invalid: boolean }
  | { period: "custom"; from: string; to: string; invalid: false };

function isPreset(value: unknown): value is EarningsPreset {
  return typeof value === "string" && (EARNINGS_PRESETS as readonly string[]).includes(value);
}

/** Reads the URL's choice; never throws. A broken or over-long custom range falls back to the default. */
export function parseEarningsPeriod(params: {
  range?: string | null;
  date?: string | null;
  from?: string | null;
  to?: string | null;
}): EarningsPeriodChoice {
  const range = params.range ?? "";
  if (range === "") return { period: DEFAULT_EARNINGS_PERIOD, invalid: false };
  if (isPreset(range)) return { period: range, invalid: false };
  const fallback = { period: DEFAULT_EARNINGS_PERIOD, invalid: true } as const;
  let from: string;
  let to: string;
  if (range === "date") {
    const day = isoDay.safeParse(params.date ?? "");
    if (!day.success) return fallback;
    from = day.data;
    to = day.data;
  } else if (range === "range") {
    const a = isoDay.safeParse(params.from ?? "");
    const b = isoDay.safeParse(params.to ?? params.from ?? "");
    if (!a.success || !b.success) return fallback;
    [from, to] = a.data <= b.data ? [a.data, b.data] : [b.data, a.data];
  } else {
    return fallback;
  }
  const days = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (days > MAX_EARNINGS_RANGE_DAYS) return fallback;
  return { period: "custom", from, to, invalid: false };
}

/** The `[start, end]` day markers of a choice, from one source's own "today". Pure. */
export function earningsRange(choice: EarningsPeriodChoice, today: Date): { start: Date; end: Date } {
  switch (choice.period) {
    case "7d":
      return { start: addDays(today, -6), end: today };
    case "30d":
      return { start: addDays(today, -29), end: today };
    case "90d":
      return { start: addDays(today, -89), end: today };
    case "month":
      return monthRangeUtc(today);
    case "custom":
      return { start: new Date(`${choice.from}T00:00:00.000Z`), end: new Date(`${choice.to}T00:00:00.000Z`) };
  }
}

/** The shared date filter's value for a choice (a custom range is always shown as a range). */
export function earningsFilterValue(choice: EarningsPeriodChoice): { range: string; date: string; from: string; to: string } {
  return choice.period === "custom"
    ? { range: "range", date: "", from: choice.from, to: choice.to }
    : { range: choice.period, date: "", from: "", to: "" };
}
