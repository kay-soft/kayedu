/**
 * The arithmetic behind soft URL state (docs/02-architecture.md §14): how a
 * submitted filter form (or a programmatic change) becomes the next query
 * string. Pure on purpose — no React, no router, no `@/` imports — so
 * `check:design` can assert it by running it.
 *
 * - **Fields the form owns replace what the URL held for them.** A field that
 *   comes back empty *removes* the param, so "All" never leaves `?status=` in
 *   the address bar.
 * - **Params the form does not own are kept** (`?child=`, a sibling form's
 *   filter, a `?q=` the page reads) — a native GET submit would have dropped
 *   them.
 * - **`page` resets to the first page whenever the filter set changed**, and
 *   survives a re-submit of the same filters (a page 3 stays page 3).
 */

/** Order-insensitive fingerprint of every param except `page`. */
function filterFingerprint(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== "page")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("&");
}

export function mergeFilterParams(
  current: URLSearchParams,
  fields: Iterable<readonly [string, string]>,
): URLSearchParams {
  const entries = [...fields];
  const next = new URLSearchParams(current);

  for (const name of new Set(entries.map(([key]) => key))) next.delete(name);
  for (const [name, value] of entries) {
    if (value.trim() !== "") next.append(name, value);
  }

  if (filterFingerprint(current) !== filterFingerprint(next)) next.delete("page");
  return next;
}
