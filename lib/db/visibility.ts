// Relative import on purpose — `npm run check:visibility` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/analytics.ts and lib/db/organizations.ts).
import { addDays, centreTimeZone, dateKey, todayInTimezone } from "../scheduling.ts";

/**
 * The data-visibility window (M19, docs/00-master-product-spec.md §5.1 "Data
 * visibility window", docs/01-data-model.md §7). By default, no centre-side
 * role (OWNER/MANAGER/RECEPTIONIST/ACCOUNTANT) may read analytics, money, old
 * sessions or attendance history older than this many days back — a *rolling*
 * window ending today, not "the 1st of this calendar month": the spec's "1
 * calendar month" is expressed as a day count (`CenterSettings.
 * dataVisibilityDays`, default 30) precisely so a centre widening it, or a
 * platform admin's bypass, takes effect on the very next request with nothing
 * to backfill — an anchored "since the 1st" window would instead jump
 * backwards by up to 30 days at the start of every new month, which is not
 * what "how far back can this role see" is supposed to mean.
 *
 * TEACHER/STUDENT/PARENT reads are never windowed — the settled decision is
 * scoped to centre-side ERP roles only (spec §3's role table: "no centre-side
 * role may read data older than..."). Settlement/payout records and audit
 * logs are carved out and must never call this at all (`scoped(ctx).
 * settlements`/`auditLogs` — see lib/db/scoped.ts); refunds are windowed.
 *
 * SEC-62 (SYS): the floor lives in the scoped helpers alongside `centerId` —
 * `scoped(ctx)` injects `centreReadFloor(ctx)` into every session, attendee,
 * attendance-change, payment and expense read, and only
 * `scopedIgnoringVisibilityWindow(ctx, reason)` (writers' integrity checks,
 * settlement and audit reads) reads past it.
 */
export const DEFAULT_VISIBILITY_WINDOW_DAYS = 30;

/**
 * A minimal, structural slice of `TenantContext` (`lib/auth/tenant.ts`) — a
 * real `TenantContext` satisfies this directly (its `settings` is a full
 * `CenterSettings | null`), and a gate script can build one without
 * constructing a whole fake tenant context just to reach
 * `dataVisibilityDays`/`timezone`.
 */
type VisibilityAwareContext = {
  isPlatformAdmin: boolean;
  settings: { dataVisibilityDays: number; timezone: string } | null;
};

/**
 * The oldest date a centre-side role may read historical data for right now,
 * or `null` when unbounded — the platform-admin bypass (spec §3: "Super Admin
 * ... Bypasses the data-visibility window"). A centre with no `CenterSettings`
 * row yet (should not happen post-M2, but every other reader of this table
 * treats a missing row as "use the default" the same way) falls back to
 * `DEFAULT_VISIBILITY_WINDOW_DAYS` and the default timezone.
 *
 * R7b: "today minus N days" counts back from the **centre's** calendar day
 * (`todayInTimezone`), so the floor flips at the centre's midnight, not
 * UTC's. Between 00:00 and 03:00 Cairo time the UTC-anchored floor was a day
 * too old.
 */
export function visibilityWindowFloor(
  ctx: VisibilityAwareContext,
  now: Date = new Date(),
): Date | null {
  if (ctx.isPlatformAdmin) return null;
  const days = ctx.settings?.dataVisibilityDays ?? DEFAULT_VISIBILITY_WINDOW_DAYS;
  return addDays(todayInTimezone(centreTimeZone(ctx.settings), now), -days);
}

/** The roles the window binds — the centre-side ERP roles (docs/01 §7). */
const CENTRE_SIDE_ROLES: ReadonlySet<string> = new Set(["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT"]);

/**
 * The floor `scoped(ctx)` injects into every session, attendee, attendance-
 * change, payment and expense read (SEC-62, CLAUDE.md rule 9): the window
 * floor for a centre-side role, `null` (unbounded) for a platform admin and
 * for a TEACHER/STUDENT/PARENT context, whose reads are never windowed.
 */
export function centreReadFloor(
  ctx: VisibilityAwareContext & { role: string },
  now: Date = new Date(),
): Date | null {
  if (!CENTRE_SIDE_ROLES.has(ctx.role)) return null;
  return visibilityWindowFloor(ctx, now);
}

/** Whether `date` falls on or after the window floor — always true when unbounded. */
export function isWithinVisibilityWindow(date: Date, floor: Date | null): boolean {
  return !floor || date.getTime() >= floor.getTime();
}

/**
 * Raises `range.start` up to the window floor when the caller's requested
 * range reaches further back than that — never narrows a range that was
 * already inside the window. This is the enforcement point for every
 * date-filterable centre-side list/aggregate (Sessions, Analytics, Expenses):
 * the filter itself (`resolveSharedDateFilter`) accepts any `from`/`to` a
 * request supplies, by design (docs/01 §7 "a direct URL or API call must not
 * bypass it") — clamping happens here, once, right before the range reaches a
 * query, so a manipulated `?from=2020-01-01` cannot reach further back than a
 * legitimate one could.
 */
export function clampRangeToVisibility<T extends { start: Date; end: Date }>(
  range: T,
  floor: Date | null,
): T {
  if (!floor || range.start.getTime() >= floor.getTime()) return range;
  return { ...range, start: floor };
}

/**
 * When an expense may be dated (SEC-2b, D-24, SEC-51): backdated **within**
 * the visibility window (a late-entered receipt is legitimate), never older
 * than the window floor (a month the centre can no longer see), never in the
 * future, all in the centre's calendar. A platform admin has no floor.
 */
export function expenseDateError(
  ctx: VisibilityAwareContext,
  date: Date,
  now: Date = new Date(),
): "futureDate" | "beforeWindow" | null {
  const today = todayInTimezone(centreTimeZone(ctx.settings), now);
  if (dateKey(date) > dateKey(today)) return "futureDate";
  const floor = visibilityWindowFloor(ctx, now);
  if (floor && date < floor) return "beforeWindow";
  return null;
}
