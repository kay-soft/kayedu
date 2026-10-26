"use client";

import { useCallback, useTransition, type ComponentProps } from "react";
import { useSearchParams } from "next/navigation";

import { usePathname, useRouter } from "@/lib/i18n/navigation";
import { mergeFilterParams } from "@/lib/ui/url-filter-params";
import { UrlFilterSyncContext } from "@/lib/ui/url-filter-sync";
import { useReportUrlPending } from "@/lib/ui/url-pending";

/**
 * `push` for a discrete change (a select, a toggle, a tab, a date Apply, a
 * page) so Back undoes it; `replace` for a change that should not add a
 * history entry of its own.
 */
export type UrlNavigationMode = "push" | "replace";

/**
 * Soft navigation for URL state (docs/02-architecture.md §14).
 *
 * The URL stays the one source of truth and Server Components keep reading
 * `searchParams`; this only changes *how* the URL moves. Every change runs
 * inside a transition on next-intl's router with `scroll: false`, so the
 * document is not reloaded, the scroll position is kept, and the old results
 * stay on screen (dimmed through `ResultsRegion`) until the new ones arrive —
 * no loading.tsx flash, no layout shift.
 *
 * - `submit(form)` serialises a filter form the way a GET submit would and
 *   merges it into the current query (`mergeFilterParams`).
 * - `update(fields)` is the same merge for a change that has no form.
 */
export function useUrlFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  useReportUrlPending(isPending);

  const update = useCallback(
    (
      fields: Iterable<readonly [string, string]>,
      { mode = "push" }: { mode?: UrlNavigationMode } = {},
    ) => {
      const current = new URLSearchParams(window.location.search);
      const next = mergeFilterParams(current, fields);
      const query = next.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      // Re-applying exactly what is already in the address bar refreshes the
      // results but never stacks a duplicate history entry.
      const effective = query === current.toString() ? "replace" : mode;

      startTransition(() => {
        if (effective === "replace") router.replace(href, { scroll: false });
        else router.push(href, { scroll: false });
      });
    },
    [pathname, router],
  );

  const submit = useCallback(
    (form: HTMLFormElement, options?: { mode?: UrlNavigationMode }) => {
      const fields: [string, string][] = [];
      for (const [name, value] of new FormData(form).entries()) {
        if (typeof value === "string") fields.push([name, value]);
      }
      update(fields, options);
    },
    [update],
  );

  return { isPending, update, submit };
}

/**
 * The one filter `<form>` (docs/04-design-system.md §5 "Filter row").
 *
 * Without JavaScript it is a plain GET form — no `action`, so it submits to
 * the page it is on and the query string carries the state. With JavaScript
 * its submit is intercepted and becomes a soft navigation (`useUrlFilters`),
 * and it tells the controls inside it when the URL moves (Back, a reset, the
 * server normalising a value) so they re-seed instead of showing stale state.
 *
 * `check:design` asserts no other GET filter form exists.
 */
export function UrlFilterForm({
  mode,
  onSubmit,
  ...props
}: Omit<ComponentProps<"form">, "action" | "method"> & { mode?: UrlNavigationMode }) {
  const filters = useUrlFilters();
  const search = useSearchParams().toString();

  return (
    <UrlFilterSyncContext value={search}>
      <form
        {...props}
        onSubmit={(event) => {
          onSubmit?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          filters.submit(event.currentTarget, { mode });
        }}
      />
    </UrlFilterSyncContext>
  );
}
