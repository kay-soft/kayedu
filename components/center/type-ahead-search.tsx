"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "@/lib/i18n/navigation";
import { cn } from "@/lib/utils";

export type TypeAheadResult = {
  id: string;
  /** The matched record's display name. */
  primary: string;
  /** The matched field shown alongside — code/phone/email. */
  secondary?: string;
  /** Where selecting this result navigates (a detail page, or `?studentId=…`). */
  href: string;
};

/** Debounce, minimum query length and result bound (docs/02-architecture.md §14,
 * docs/04-design-system.md §11.8) — stated here since every screen shares them. */
const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 8;

/** Gap between the input and the panel, and the panel's own height bounds. */
const PANEL_GAP = 4;
const PANEL_MIN_HEIGHT = 176;
const PANEL_MAX_HEIGHT = 288;

/**
 * Placement must happen before the browser paints, or the panel flashes at
 * the top-left of the viewport for a frame. `useLayoutEffect` does that, but
 * React warns when it runs during SSR — so on the server this degrades to
 * `useEffect`, which never runs there anyway.
 */
const useIsomorphicLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

/**
 * The one live type-ahead search input (M18, docs/04 §11.8). A plain GET
 * form underneath — search state still lives in the URL and a full-page
 * submit still works with no JavaScript, which is what keeps Reception's
 * hardware barcode scanner working (it types a code fast and presses Enter;
 * this component never intercepts that when no suggestion is highlighted).
 * On top of that, typing debounces into `search(query)` and renders a
 * bounded dropdown of matches, each an explicit link — never an auto-submit
 * on select, since choosing a result and submitting the underlying search
 * are two different actions here.
 */
export function TypeAheadSearch({
  name = "q",
  value,
  label,
  placeholder,
  submitLabel,
  keep,
  search,
  emptyAction,
}: {
  name?: string;
  value?: string;
  label: string;
  placeholder?: string;
  submitLabel: string;
  keep?: Record<string, string | undefined>;
  /** Server Action: bounded, debounced results for the typed query. */
  search: (query: string) => Promise<TypeAheadResult[]>;
  /** Rendered in the "no results" state — e.g. an "add new" link. */
  emptyAction?: React.ReactNode;
}) {
  const t = useTranslations("Shared.typeAhead");
  const router = useRouter();
  const inputId = useId();
  const listboxId = useId();

  const [query, setQuery] = useState(value ?? "");
  const [results, setResults] = useState<TypeAheadResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  const queryTooShort = query.trim().length < MIN_QUERY_LENGTH;

  useEffect(() => {
    const trimmed = query.trim();
    // Too-short is silent by design (docs/04 §11.8) — no panel, no fetch, and
    // deliberately no state write here either; visibility below is gated on
    // `queryTooShort` at render time instead, so this early return never
    // triggers a cascading re-render from inside the effect.
    if (trimmed.length < MIN_QUERY_LENGTH) return;

    const id = ++requestId.current;
    const timer = setTimeout(() => {
      setLoading(true);
      search(trimmed)
        .then((rows) => {
          if (requestId.current !== id) return;
          setResults(rows.slice(0, MAX_RESULTS));
          setSearched(true);
          setOpen(true);
          setActiveIndex(-1);
        })
        .finally(() => {
          if (requestId.current === id) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, search]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      // The panel is portalled to <body>, so it is not inside `containerRef`
      // any more — it has to be checked separately or every click on a
      // result would read as a click outside and close the list first.
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Position the portalled panel against the input, in viewport coordinates.
  // Written straight to the node rather than through state: this runs on
  // every scroll frame, and re-rendering the whole list to move it would be
  // both wasteful and a cascading-render hazard.
  useIsomorphicLayoutEffect(() => {
    if (!open || queryTooShort) return;
    const field = fieldRef.current;
    const panel = panelRef.current;
    if (!field || !panel) return;

    function place() {
      if (!field || !panel) return;
      const rect = field.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - PANEL_GAP * 2;
      const above = rect.top - PANEL_GAP * 2;
      // Flip above the input only when there is genuinely more room there —
      // at a desk the input is usually near the top and this never fires.
      const flip = below < PANEL_MIN_HEIGHT && above > below;
      const room = Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, flip ? above : below));

      // `left`/`width` come from the measured rect, so this lands over the
      // input in both reading directions without a special case (docs/04 §7).
      panel.style.width = `${rect.width}px`;
      panel.style.left = `${rect.left}px`;
      panel.style.maxHeight = `${room}px`;
      panel.style.top = flip
        ? `${Math.max(PANEL_GAP, rect.top - Math.min(panel.offsetHeight, room) - PANEL_GAP)}px`
        : `${rect.bottom + PANEL_GAP}px`;
      panel.style.visibility = "visible";
    }

    place();
    // `true` catches scrolling in any ancestor container, not just the page.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, queryTooShort, results, loading, searched, activeIndex]);

  function select(result: TypeAheadResult) {
    setOpen(false);
    router.push(result.href);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index <= 0 ? results.length - 1 : index - 1));
    } else if (event.key === "Escape") {
      setOpen(false);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      // Only intercept Enter when a suggestion is actually highlighted —
      // otherwise the barcode scanner's Enter must reach the real <form>
      // submit untouched (docs/04 §11.8).
      event.preventDefault();
      select(results[activeIndex]);
    }
  }

  return (
    <form className="flex flex-col gap-2 sm:flex-row sm:items-end" role="search">
      {Object.entries(keep ?? {}).map(([key, keepValue]) =>
        keepValue ? (
          <input key={key} type="hidden" name={key} value={keepValue} />
        ) : null,
      )}

      <div ref={containerRef} className="relative flex min-w-0 flex-1 flex-col gap-1.5">
        <label htmlFor={inputId} className="text-xs font-medium text-text-secondary">
          {label}
        </label>
        <div ref={fieldRef} className="relative">
          <Input
            id={inputId}
            name={name}
            type="search"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onFocus={() => {
              if (results.length > 0) setOpen(true);
            }}
            placeholder={placeholder}
            maxLength={80}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
          />
          {loading && !queryTooShort ? (
            <Loader2 className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-text-muted" />
          ) : null}
        </div>

        {open && !queryTooShort
          ? createPortal(
              <div
                ref={panelRef}
                id={listboxId}
                role="listbox"
                // Portalled to <body> and positioned in viewport coordinates,
                // so no ancestor can clip it. `Card` sets `overflow-hidden`
                // for its rounded corners, and the search box sits inside a
                // card on every screen that has one — which used to cut this
                // panel off at the card's bottom edge.
                style={{ visibility: "hidden" }}
                className="fixed z-50 overflow-y-auto rounded-lg border border-border bg-surface shadow-popover"
              >
                {results.length > 0 ? (
                  <ul className="py-1">
                    {results.map((result, index) => (
                      <li key={result.id} role="option" aria-selected={index === activeIndex}>
                        <button
                          type="button"
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => select(result)}
                          className={cn(
                            "flex w-full flex-col gap-0.5 px-3 py-2 text-start text-sm",
                            "transition-ui-fast focus-ring",
                            index === activeIndex
                              ? "bg-brand/10 text-brand"
                              : "hover:bg-surface-hover active:bg-surface-active",
                          )}
                        >
                          <span className="truncate font-medium text-text-primary">
                            {result.primary}
                          </span>
                          {result.secondary ? (
                            <span className="truncate text-xs text-text-muted" dir="ltr">
                              {result.secondary}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : searched && !loading ? (
                  <div className="flex flex-col gap-2 px-3 py-3 text-sm text-text-muted">
                    <span>{t("noResults")}</span>
                    {emptyAction}
                  </div>
                ) : null}
              </div>,
              document.body,
            )
          : null}
      </div>

      <Button type="submit" variant="outline" className="h-11 px-4">
        <Search className="size-4" />
        {submitLabel}
      </Button>
    </form>
  );
}
