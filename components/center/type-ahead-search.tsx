"use client";

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, ScanLine, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Ltr } from "@/components/shared/ltr";
import { useUrlFilters } from "@/components/shared/url-filters";
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
  /**
   * A short-lived signed photo URL, for a screen that hands the pick to a
   * confirm panel (the session page's add-attendee search). Optional.
   */
  photoUrl?: string | null;
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
 *
 * **A pick stays picked (T2).** Choosing a suggestion closes the panel and it
 * must not come back on its own: not when the page re-renders around it, not
 * when the input is refocused, not when a navigation hands this component a
 * fresh `search` function (a `.bind`ed Server Action is a new function every
 * render, which re-ran the effect below and reopened the list). The text the
 * pick was made for — or that arrived from the URL on load — is recorded in
 * `settledQuery`; the effect, the late-result handler and the focus handler all
 * stand down for exactly that text, and only a keystroke (which changes it)
 * lets the panel open again.
 *
 * **Soft submit (T4).** On a list or detail page the submit is a soft
 * navigation (`useUrlFilters`, docs/02 §14): the form still GETs without
 * JavaScript, but with it the URL changes in place — no document reload, scroll
 * kept, results dimmed while the next ones load — and the field re-seeds from
 * `value` when the URL moves (Back). Reception's own scan field opts out with
 * `softSubmit={false}`: the scanner contract above is verified against the
 * full-page submit and stays exactly that. Session mode (`onSubmitValue`) never
 * navigates at all.
 *
 * `onClear` adds a clear (X) control and makes Escape — when no list is open —
 * do the same: the reception desk's way back to its default state.
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
  onClear,
  softSubmit = true,
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
   * When set, a clear (X) control shows in the field and Escape (with no list
   * open) calls it after emptying the input. The screen decides what "clear"
   * means — the desk returns to its default state — and passes this only while
   * there is something to clear.
   */
  onClear?: () => void;
  /**
   * Submit as a soft navigation (default). `false` keeps the plain full-page
   * GET submit — Reception's scan field only (the scanner contract, R7).
   */
  softSubmit?: boolean;
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
  const urlFilters = useUrlFilters();
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
  // Text whose suggestions must not (re)open the panel: what a pick was made
  // for, or what the URL handed us on load. Cleared by the next keystroke.
  const settledQuery = useRef<string | null>(value ? value : null);

  // On a soft-submit search the field mirrors the URL: when `value` changes
  // (Back, a clear-search link) the typed text and any open suggestions go with
  // it. Reception's field (`softSubmit={false}`) and session mode keep today's
  // behaviour — their text is theirs, whatever the URL does around them.
  const mirrorsUrl = softSubmit && !onSubmitValue;
  const [seenValue, setSeenValue] = useState(value ?? "");
  if (mirrorsUrl && (value ?? "") !== seenValue) {
    setSeenValue(value ?? "");
    setQuery(value ?? "");
    setResults([]);
    setSearched(false);
    setOpen(false);
    setActiveIndex(-1);
  }
  // Declared before the search effect below, so the new settled text is in
  // place when that effect decides whether to fetch.
  useEffect(() => {
    if (mirrorsUrl) settledQuery.current = value ? value : null;
  }, [mirrorsUrl, value]);

  const queryTooShort = query.trim().length < MIN_QUERY_LENGTH;

  useEffect(() => {
    const trimmed = query.trim();
    // Too-short is silent by design (docs/04 §11.8) — no panel, no fetch, and
    // deliberately no state write here either; visibility below is gated on
    // `queryTooShort` at render time instead, so this early return never
    // triggers a cascading re-render from inside the effect.
    if (trimmed.length < MIN_QUERY_LENGTH) return;
    // Settled text is not searched at all — a new `search` identity or a
    // re-render must not bring the list back after a pick.
    if (settledQuery.current === query) return;

    const id = ++requestId.current;
    const timer = setTimeout(() => {
      timerRef.current = null;
      setLoading(true);
      search(trimmed)
        .then((rows) => {
          if (requestId.current !== id || settledQuery.current === query) return;
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

  function clearInput() {
    cancelPending();
    settledQuery.current = null;
    setQuery("");
    setResults([]);
    setSearched(false);
    if (inputRef.current) inputRef.current.value = "";
    inputRef.current?.focus();
  }

  function clearSelection() {
    clearInput();
    onClear?.();
  }

  useImperativeHandle(controlRef, () => ({
    clear: clearInput,
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
    settledQuery.current = inputRef.current?.value ?? query;
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
    } else if (softSubmit) {
      // A soft navigation, from the input's own value (FormData reads the DOM,
      // not React state, so the scan-between-renders rule above still holds).
      event.preventDefault();
      urlFilters.submit(event.currentTarget);
    }
    // Otherwise (Reception) the plain GET form submits the input's own value, as before.
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    // With no list open, Escape clears the selection (when the screen has one).
    if (event.key === "Escape" && onClear && !(open && results.length > 0)) {
      event.preventDefault();
      clearSelection();
      return;
    }
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
              settledQuery.current = null;
              setQuery(event.currentTarget.value);
              // A new character invalidates any highlight made for the old text.
              setActiveIndex(-1);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => {
              if (results.length > 0 && settledQuery.current !== query) setOpen(true);
            }}
            placeholder={placeholder}
            maxLength={80}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            className={cn(
              size === "lg" && "h-14 ps-12 text-base",
              // Our clear button replaces the browser's own one.
              onClear && "pe-12 [&::-webkit-search-cancel-button]:appearance-none",
            )}
          />
          {loading && !queryTooShort ? (
            <Loader2
              className={cn(
                "pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 animate-spin text-text-muted",
                onClear ? "end-12" : "end-3",
              )}
              aria-hidden
            />
          ) : null}
          {onClear ? (
            <button
              type="button"
              onClick={clearSelection}
              aria-label={t("clear")}
              className="absolute end-0.5 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg text-text-secondary transition-ui focus-ring hover:bg-surface-hover hover:text-text-primary active:bg-surface-active"
            >
              <X className="size-4" aria-hidden />
            </button>
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
                className="scrollbar-neutral fixed z-50 overflow-y-auto rounded-lg border border-border bg-surface shadow-popover"
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
