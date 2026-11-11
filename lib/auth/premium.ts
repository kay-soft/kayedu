// Relative imports on purpose: `check:admin` runs this module outside the
// Next.js runtime, where the `@/` alias does not resolve (same as lib/db/*).
import type { Prisma, PrismaClient } from "@prisma/client";

import {
  DEFAULT_TIMEZONE,
  addDays,
  dateKey,
  dayMarker,
  daysBetween,
  todayInTimezone,
  zonedClock,
  zonedDateTimeToUtc,
} from "../scheduling.ts";

/**
 * Premium (W6, D-W14, D-W35) — the one place that decides it.
 *
 * `User.premiumUntil` holds the **exclusive** end instant: the midnight that
 * follows the last covered day in Africa/Cairo (the same convention as
 * `endOfSessionDay`). Premium is `premiumUntil > now`, worked out on every
 * call — no stored boolean, no cron (rule 12). It belongs to the person, never
 * to a centre, so it is valid for any account, with or without a membership.
 *
 * `requirePremium` is the guard W7 (assistants) and W8 (workspaces) call. At W6
 * it has no caller outside the gates (`check:admin` asserts it): nothing is
 * gated by premium yet.
 */

/** The zone an end date is read in: an admin picks a day, it ends at that day's Cairo midnight. */
export const PREMIUM_TIMEZONE = DEFAULT_TIMEZONE;
/** The furthest end date an admin may pick, in days from today (Cairo). */
export const PREMIUM_MAX_DAYS_AHEAD = 400;
/** Within this many days of the end, the Premium card says "Ends in n days". */
export const PREMIUM_ENDING_SOON_DAYS = 14;

type PremiumHolder = { premiumUntil: Date | null } | null | undefined;

/** THE predicate. `premiumUntil` equal to `now` is already not premium. */
export function isPremium(user: PremiumHolder, now: Date = new Date()): boolean {
  const until = user?.premiumUntil;
  return until != null && until.getTime() > now.getTime();
}

/** Today in Cairo as "YYYY-MM-DD" — the floor an end date is checked against. */
export function premiumToday(now: Date = new Date()): string {
  return dateKey(todayInTimezone(PREMIUM_TIMEZONE, now));
}

/** The latest end date an admin may pick today, "YYYY-MM-DD". */
export function premiumLatestEndDay(now: Date = new Date()): string {
  return dateKey(addDays(todayInTimezone(PREMIUM_TIMEZONE, now), PREMIUM_MAX_DAYS_AHEAD));
}

export type PremiumDateError = "invalidDate" | "dateInPast" | "dateTooFar";

/** A real calendar day "YYYY-MM-DD" (rejects 2026-02-30). */
function isCalendarDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return dateKey(dayMarker(day)) === day;
}

/**
 * The one rule for an end date: a real day, today or later, at most
 * `PREMIUM_MAX_DAYS_AHEAD` days ahead (exactly 400 passes, 401 fails), all in
 * Cairo. `null` = valid. zod and the writer both call this.
 */
export function premiumEndDayError(day: string, now: Date = new Date()): PremiumDateError | null {
  if (!isCalendarDay(day)) return "invalidDate";
  if (day < premiumToday(now)) return "dateInPast";
  if (day > premiumLatestEndDay(now)) return "dateTooFar";
  return null;
}

/** The stored instant for an end day: the Cairo midnight that follows it. */
export function premiumUntilForDay(day: string): Date {
  return zonedDateTimeToUtc(dateKey(addDays(dayMarker(day), 1)), 0, PREMIUM_TIMEZONE);
}

/** The last covered day of a stored end instant, "YYYY-MM-DD" in Cairo. */
export function premiumEndDay(premiumUntil: Date): string {
  return zonedClock(new Date(premiumUntil.getTime() - 1), PREMIUM_TIMEZONE).dayKey;
}

export type PremiumStatus =
  | { kind: "none" }
  | { kind: "active"; endDay: string; daysLeft: number; endingSoon: boolean }
  | { kind: "expired"; endDay: string };

/**
 * What the admin page and the Premium card show. `daysLeft` counts Cairo days
 * from today to the last covered day (0 = it ends today).
 */
export function premiumStatus(premiumUntil: Date | null, now: Date = new Date()): PremiumStatus {
  if (!premiumUntil) return { kind: "none" };
  const endDay = premiumEndDay(premiumUntil);
  if (!isPremium({ premiumUntil }, now)) return { kind: "expired", endDay };
  const daysLeft = Math.max(0, daysBetween(todayInTimezone(PREMIUM_TIMEZONE, now), dayMarker(endDay)));
  return { kind: "active", endDay, daysLeft, endingSoon: daysLeft <= PREMIUM_ENDING_SOON_DAYS };
}

export type PremiumGate = { ok: true; premiumUntil: Date } | { ok: false; error: "premiumRequired" };

/**
 * The guard for a premium-only feature (W7, W8). It reads the account fresh —
 * pass the feature's own transaction client so the check and the write see the
 * same row — and refuses with the typed `premiumRequired`. An unknown account
 * is refused the same way.
 */
export async function requirePremium(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  now: Date = new Date(),
): Promise<PremiumGate> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { premiumUntil: true } });
  if (!user || !isPremium(user, now)) return { ok: false, error: "premiumRequired" };
  return { ok: true, premiumUntil: user.premiumUntil! };
}
