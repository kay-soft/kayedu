/**
 * The plain constants of branch creation (F1), shared by the data layer
 * (`lib/db/platform.ts`, `lib/db/branches.ts`), the zod schemas and the
 * client dialogs. No imports, so a client component can read it without
 * pulling in the data layer.
 */

/** The highest branch limit the admin editor accepts — a typo guard, not a product rule. */
export const MAX_BRANCH_LIMIT = 500;

/**
 * What "Copy setup from <branch>" can carry over (all ticked by default).
 * Never copied, by design: rooms, classes, sessions, people, money, the
 * ID-card layout and the logo.
 */
export const BRANCH_COPY_KEYS = [
  "catalog",
  "paymentMethods",
  "terms",
  "holidays",
  "permissions",
  "generalSettings",
] as const;

export type BranchCopyKey = (typeof BRANCH_COPY_KEYS)[number];

/** The timezones a branch may run on — the same list General settings offers. */
export const CENTER_TIMEZONES = ["Africa/Cairo", "Asia/Riyadh", "Asia/Dubai", "UTC"] as const;

/**
 * Theme colours offered for a new branch. A branch's theme colour is its own
 * data (docs/04 §9 "Per-tenant theming"), not UI chrome: the first is the
 * platform default (`--brand`), the rest are the demo organizations' colours.
 */
export const BRANCH_THEME_SWATCHES = [
  "#2563EB",
  "#0D9488",
  "#7C3AED",
  "#F59E0B",
  "#DC2626",
  "#16A34A",
] as const;

/** The longest branch pause, in days, both ends included (U5; a CHECK backs it up). */
export const MAX_PAUSE_DAYS = 90;

/** The optional reason kept on a pause — never in its audit row (D-20). */
export const BRANCH_PAUSE_REASON_MAX = 300;

/** How long a deleted branch stays restorable from the admin page (U5). */
export const RESTORE_WINDOW_DAYS = 30;
