/**
 * The branch-scope guard (T6, docs/02-architecture.md §4 "Whole Management is
 * analytics-only").
 *
 * Under an Owner's "Whole Management" choice the resolved context still holds
 * one real branch (the representative one), so without this guard a centre
 * page or action would quietly read or write that branch. Only Analytics
 * means anything across the organization; everything else must make the
 * owner pick a branch first.
 *
 * Every centre Server Action calls `requireBranchScope(ctx)` straight after
 * `getTenantContext("center")` and returns `PICK_BRANCH` before any read or
 * write; every centre page (except Analytics) renders the pick-a-branch screen
 * on the same test. `check:design` asserts the call sites statically.
 *
 * Free of Next-runtime imports on purpose, so gate scripts can import it.
 */

/** The typed refusal a centre action returns under "Whole Management". */
export const PICK_BRANCH = { error: "pickBranch" } as const;

export type PickBranch = typeof PICK_BRANCH;

/**
 * `PICK_BRANCH` when the request is an organization roll-up, else `null` —
 * the caller stops before reading or writing anything.
 */
export function requireBranchScope(ctx: { rollupOrganizationId: string | null }): PickBranch | null {
  return ctx.rollupOrganizationId ? PICK_BRANCH : null;
}

/** Narrows a scope helper's result that may be the roll-up refusal. */
export function isPickBranch(value: unknown): value is PickBranch {
  return value === PICK_BRANCH;
}
