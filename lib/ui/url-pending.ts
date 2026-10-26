import { useEffect, useSyncExternalStore } from "react";

/**
 * "A URL-state navigation is in flight" — one tiny store, so the control that
 * started it (a select, a pager link, a date Apply) and the results region it
 * is about to replace can be different components anywhere in the tree
 * without a provider (docs/04-design-system.md §5 "Filter row", pending state).
 *
 * A counter, not a boolean: two controls can be pending at once and the
 * region must stay busy until the *last* one lands.
 */
let inFlight = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Mirrors a `useTransition` / `useLinkStatus` pending flag into the store. */
export function useReportUrlPending(pending: boolean) {
  useEffect(() => {
    if (!pending) return;
    inFlight += 1;
    emit();
    return () => {
      inFlight -= 1;
      emit();
    };
  }, [pending]);
}

/** True while any URL-state navigation is pending. The server snapshot is always false. */
export function useUrlPending(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => inFlight > 0,
    () => false,
  );
}
