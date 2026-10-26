import { createContext, useContext } from "react";

/**
 * The current query string, provided only by `UrlFilterForm`
 * (`components/shared/url-filters.tsx`).
 *
 * A filter control (`Select`, `DatePicker`, `DateFilter`) seeds its own state
 * from a `defaultValue` once. With a document reload that was enough — every
 * filter change rebuilt the page. Now that a filter change is a soft
 * navigation the control stays mounted, so when the URL moves *without* the
 * user touching it (Back, Forward, a reset link, the server normalising a
 * value) it must take the new server value instead of showing a stale one.
 * It does that by comparing this string between renders.
 *
 * `null` outside a filter form: the controls in an edit form or a dialog never
 * see it change, so they keep what the user typed (the old behaviour).
 */
export const UrlFilterSyncContext = createContext<string | null>(null);

export function useUrlFilterSync(): string | null {
  return useContext(UrlFilterSyncContext);
}
