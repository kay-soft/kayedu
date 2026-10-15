"use client";

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, ScanLine, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Ltr } from "@/components/shared/ltr";
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

/** What a screen can do to the input from outside (R7: clear and refocus after a completed check-in). */
export type TypeAheadHandle = { clear: () => void; focus: () => void };

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
 *
 * **Scanner contract (R7).** A handheld USB scanner types the whole code in a
 * few milliseconds and ends with Enter, usually inside the 300 ms debounce
 * window. So: (1) a submit reads the value from the input element itself
 * (`inputRef.current.value`), never from React state or a debounced copy;
 * (2) a submit cancels the pending debounce and any in-flight search, so a
 * late result can neither reopen the panel nor be applied after the scan;
 * (3) Enter selects a suggestion only when it was highlighted **with the
 * arrow keys** — hovering never arms Enter, and typing clears the highlight,
 * so a scan can never select a stale suggestion under a resting mouse.
 * Session mode (R7) passes `onSubmitValue`/`onSelect` to take over both
 * paths without a page navigation.
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
  autoFocus,
  inputId: inputIdProp,
  controlRef,
  onSubmitValue,
  onSelect,
  size = "default",
  hideLabel,
  hint,
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
  /** Focus the input on load (the reception desk's scan input). */
  autoFocus?: boolean;
  /** A stable id for the input, when another component needs to find it to refocus it. */
  inputId?: string;
  /** Imperative clear/focus for the screen that owns the input. */
  controlRef?: React.Ref<TypeAheadHandle>;
  /**
   * When set, a submit (Enter / the button) does not navigate: it hands over
   * the input element's own value instead.
   */
  onSubmitValue?: (value: string) => void;
  /** When set, choosing a suggestion calls this instead of navigating to its `href`. */
  onSelect?: (result: TypeAheadResult) => void;
  /**
   * `lg` is the reception desk's find / scan field (docs/04 §14.5): 56px, a
   * scan icon at its start, a larger type size.
   */
  size?: "default" | "lg";
  /** Keep the label for assistive technology only, when a card title already says it. */
  hideLabel?: boolean;
  /** A line under the field (session mode's "Ready to scan"). */
  hint?: React.ReactNode;
}) {
  const t = useTranslations("Shared.typeAhead");
  const router = useRouter();
  const generatedInputId = useId();
  const inputId = inputIdProp ?? generatedInputId;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      timerRef.current = null;
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
    timerRef.current = timer;

    return () => clearTimeout(timer);
  }, [query, search]);

  /** Drop the pending debounce and any in-flight search; close the panel. */
  function cancelPending() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    requestId.current += 1;
    setLoading(false);
    setOpen(false);
    setActiveIndex(-1);
  }

  useImperativeHandle(controlRef, () => ({
    clear: () => {
      cancelPending();
      setQuery("");
      setResults([]);
      setSearched(false);
      if (inputRef.current) inputRef.current.value = "";
      inputRef.current?.focus();
    },
    focus: () => inputRef.current?.focus(),
  }));

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
    cancelPending();
    if (onSelect) onSelect(result);
    else router.push(result.href);
  }

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    // The element's own value: a scan can finish between two React renders.
    const submitted = inputRef.current?.value ?? query;
    cancelPending();
    if (onSubmitValue) {
      event.preventDefault();
      onSubmitValue(submitted);
    }
    // Otherwise the plain GET form submits the input's own value, as before.
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
      // Only intercept Enter when a suggestion is actually highlighted *with
      // the arrow keys* — otherwise the barcode scanner's Enter must reach
      // the real <form> submit untouched (docs/04 §11.8).
      event.preventDefault();
      select(results[activeIndex]);
    }
  }

  return (
    <form
      // With a visible label the button sits on the field's baseline; with the
      // label hidden (the desk's scan field) it aligns to the field's top, so a
      // hint under the field does not push it down.
      className={cn("flex flex-col gap-2 sm:flex-row", hideLabel ? "sm:items-start" : "sm:items-end")}
      role="search"
      onSubmit={onSubmit}
    >
      {Object.entries(keep ?? {}).map(([key, keepValue]) =>
        keepValue ? (
          <input key={key} type="hidden" name={key} value={keepValue} />
        ) : null,
      )}

      <div ref={containerRef} className="relative flex min-w-0 flex-1 flex-col gap-1.5">
        <label htmlFor={inputId} className={hideLabel ? "sr-only" : "text-xs font-medium text-text-secondary"}>
          {label}
        </label>
        <div ref={fieldRef} className="relative">
          {size === "lg" ? (
            <ScanLine
              className="pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2 text-text-secondary"
              aria-hidden
            />
          ) : null}
          <Input
            ref={inputRef}
            id={inputId}
            name={name}
            type="search"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            autoFocus={autoFocus}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              // A new character invalidates any highlight made for the old text.
              setActiveIndex(-1);
            }}
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
            className={size === "lg" ? "h-14 ps-12 text-base" : undefined}
          />
          {loading && !queryTooShort ? (
            <Loader2
              className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-text-muted"
              aria-hidden
            />
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
                            <span className="truncate text-xs text-text-secondary">
                              <Ltr>{result.secondary}</Ltr>
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : searched && !loading ? (
                  <div className="flex flex-col gap-2 px-3 py-3 text-sm text-text-secondary">
                    <span>{t("noResults")}</span>
                    {emptyAction}
                  </div>
                ) : null}
              </div>,
              document.body,
            )
          : null}
        {hint ? <div className="text-xs text-text-secondary">{hint}</div> : null}
        {/* Says what the search found without moving focus (docs/04 §14.5). */}
        <p className="sr-only" aria-live="polite">
          {queryTooShort ? "" : loading ? t("searching") : searched ? t("resultCount", { count: results.length }) : ""}
        </p>
      </div>

      <Button type="submit" variant="outline" className={size === "lg" ? "h-14 px-5" : "h-11 px-4"}>
        <Search className="size-4" aria-hidden />
        {submitLabel}
      </Button>
    </form>
  );
}
