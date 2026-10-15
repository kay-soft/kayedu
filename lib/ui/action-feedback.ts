"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

import { notify } from "@/components/ui/toast";

/**
 * Every mutation answers (docs/04-design-system.md §14.2).
 *
 * The Server Actions are unchanged — they already return
 * `{ status } | { error } | { fieldErrors }` (docs/02 §7). These two hooks are
 * the client half: they make sure a result is never dropped on the floor.
 */

type ResultState = { status?: string | null; error?: string | null } | null | undefined;

/**
 * Toasts a translated success **once per result**: `useActionState` returns a
 * new object for every submission, so the same status twice in a row still
 * answers twice. `success` maps a status to the message (or `null` to stay
 * quiet — e.g. a form whose success replaces itself with a panel). An optional
 * `error` maps an error key to a toast for a control that has nowhere inline to
 * say it (a row's Deactivate button); a form with a body shows its error inline
 * and passes no `error`.
 */
export function useActionFeedback<S extends ResultState>(
  state: S,
  {
    success,
    error,
  }: {
    success?: string | ((status: string, state: NonNullable<S>) => string | null);
    error?: (key: string, state: NonNullable<S>) => string | null;
  },
) {
  const seen = useRef<S | null>(state);
  useEffect(() => {
    if (!state || state === seen.current) return;
    seen.current = state;
    if (state.status && success) {
      const message = typeof success === "string" ? success : success(state.status, state as NonNullable<S>);
      if (message) notify("success", message);
    } else if (state.error && error) {
      const message = error(state.error, state as NonNullable<S>);
      if (message) notify("error", message);
    }
  }, [state, success, error]);
}

/** True for a fetch that never reached the server (offline, DNS, reset). */
function isNetworkFailure(cause: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return cause instanceof TypeError && /fetch|network|load failed/i.test(cause.message);
}

/**
 * `useActionState`, plus the one failure an action cannot report itself: the
 * request never arriving. A network failure becomes an error toast with
 * **Retry**, which re-submits the same `FormData`; the state is left as it was,
 * so the form keeps everything typed. Anything else — including Next's own
 * `redirect()` / `notFound()` signals — is re-thrown untouched.
 */
export function useGuardedActionState<S>(
  action: (state: Awaited<S>, formData: FormData) => S | Promise<S>,
  initialState: Awaited<S>,
) {
  const t = useTranslations("Shared.toast");
  const dispatchRef = useRef<(formData: FormData) => void>(() => {});

  const [state, dispatch, pending] = useActionState<S, FormData>(async (previous, formData) => {
    try {
      return await action(previous, formData);
    } catch (cause) {
      if (!isNetworkFailure(cause)) throw cause;
      notify("error", t("networkError"), {
        action: {
          label: t("retry"),
          onClick: () => startTransition(() => dispatchRef.current(formData)),
        },
      });
      return previous;
    }
  }, initialState);

  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);
  return [state, dispatch, pending] as const;
}
