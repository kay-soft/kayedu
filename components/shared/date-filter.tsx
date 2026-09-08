"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, RotateCcw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export type DateFilterValue = {
  range: "day" | "week" | "month" | "date" | "range";
  /** "YYYY-MM-DD" — only meaningful when range === "date". */
  date: string;
  /** "YYYY-MM-DD" — only meaningful when range === "range". */
  from: string;
  to: string;
};

/** The three presets, paired with the message key that names each one. */
const QUICK = [
  { kind: "day", labelKey: "activeDay" },
  { kind: "week", labelKey: "activeWeek" },
  { kind: "month", labelKey: "activeMonth" },
] as const satisfies ReadonlyArray<{
  kind: DateFilterValue["range"];
  labelKey: string;
}>;

/**
 * The ONE shared date filter (docs/04-design-system.md §11.7): Day / Week
 * (today −7) / Month (1st → today), a specific date, and a custom range —
 * every screen that filters by date renders this and never its own controls.
 * The URL contract is unchanged from M18 (`range` / `date` / `from` / `to`),
 * so a bookmarked filtered view still resolves exactly as it did.
 *
 * **One control, not five.** The M18 presentation put a segmented row, two
 * separate picker toggles, two native `<input type="date">` fields and a
 * stray Reset link on four different baselines — three date affordances for
 * one job, two of them drawn by the browser rather than the design system.
 * This is a single trigger reading the active selection, opening one panel
 * that holds the presets and one calendar: pick a start, pick an end, the
 * span highlights between them, and a start with no end *is* the
 * specific-date case. There is nothing left for a second control to do.
 *
 * Still not its own `<form>` — a fragment meant to sit inside the page's
 * existing filter form alongside whatever else that screen filters by, so one
 * submit carries every field. Presets apply on click; the calendar waits for
 * Apply, so a range never re-queries after only its first date is picked.
 */
export function DateFilter({
  value,
  todayIso,
  resetHref,
}: {
  value: DateFilterValue;
  /** Today's date, "YYYY-MM-DD" — computed server-side so it can't drift from the query's own "now". */
  todayIso: string;
  /** Where "Reset" navigates — the bare page path, no query string. */
  resetHref: string;
}) {
  const t = useTranslations("Shared.dateFilter");
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DateFilterValue["range"]>(value.range);
  // The calendar's working copy. It only reaches the URL on Apply, so an
  // in-progress range is never queried.
  const [draft, setDraft] = useState<{ from: string | null; to: string | null }>(
    () => ({
      from: value.range === "range" ? value.from || null : value.date || null,
      to: value.range === "range" ? value.to || null : null,
    }),
  );
  const applyRef = useRef<HTMLButtonElement>(null);

  // Applying is a real form submit, fired from an effect so the hidden fields
  // below are already written when the form serialises — the page's other
  // filters (teacher, status, class) then ride along untouched. The flag is a
  // ref, not state, so arming it never costs an extra render.
  const pendingApply = useRef(false);
  useEffect(() => {
    if (!pendingApply.current) return;
    pendingApply.current = false;
    applyRef.current?.click();
  }, [kind, draft]);

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* What the page actually posts. Every visible control writes here, and
          only here, so there is exactly one `range` value in the query. */}
      <input type="hidden" name="range" value={kind} />
      <input
        type="hidden"
        name="date"
        value={kind === "date" ? (draft.from ?? "") : ""}
      />
      <input
        type="hidden"
        name="from"
        value={kind === "range" ? (draft.from ?? "") : ""}
      />
      <input
        type="hidden"
        name="to"
        value={kind === "range" ? (draft.to ?? "") : ""}
      />
      <button ref={applyRef} type="submit" className="sr-only" tabIndex={-1}>
        {t("apply")}
      </button>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={cn(
            "group flex h-11 min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3",
            "text-sm font-medium text-text-primary shadow-xs transition-ui outline-none",
            "hover:border-border-strong hover:bg-surface-hover",
            "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
            "data-[popup-open]:border-brand data-[popup-open]:ring-3 data-[popup-open]:ring-brand/25",
          )}
        >
          <CalendarDays className="size-4 shrink-0 text-text-muted" aria-hidden />
          <span className="min-w-0 truncate">
            <span className="text-text-muted">{t("groupLabel")}: </span>
            {describeDateFilter(value, locale, t)}
          </span>
          <ChevronDown
            className="size-4 shrink-0 text-text-muted transition-transform duration-[var(--motion-fast)] group-data-[popup-open]:rotate-180"
            aria-hidden
          />
        </PopoverTrigger>

        <PopoverContent className="w-auto max-w-none p-0">
          <div className="flex flex-col sm:flex-row">
            <div className="flex shrink-0 flex-row gap-1 border-border p-2 sm:flex-col sm:border-e">
              {QUICK.map((preset) => (
                <button
                  key={preset.kind}
                  type="button"
                  onClick={() => {
                    setKind(preset.kind);
                    setDraft({ from: null, to: null });
                    setOpen(false);
                    pendingApply.current = true;
                  }}
                  aria-current={kind === preset.kind ? true : undefined}
                  className={cn(
                    "flex min-h-11 flex-1 items-center rounded-lg px-3 text-sm font-medium whitespace-nowrap",
                    "text-text-secondary transition-ui-fast focus-ring",
                    "hover:bg-surface-hover active:bg-surface-active",
                    "aria-[current=true]:bg-brand/10 aria-[current=true]:text-brand",
                    "sm:w-40 sm:flex-none",
                  )}
                >
                  {t(preset.labelKey)}
                </button>
              ))}
            </div>

            <div className="flex flex-col">
              <Calendar
                mode="range"
                value={draft}
                onChange={setDraft}
                todayIso={todayIso}
              />
              <div className="flex items-center justify-between gap-2 border-t border-border p-2">
                <span
                  className={cn(
                    "min-w-0 truncate text-xs",
                    draft.from ? "text-text-secondary" : "text-text-muted",
                  )}
                >
                  {draft.from
                    ? describeDraft(draft, locale, t)
                    : t("pickRangeHint")}
                </span>
                <button
                  type="button"
                  disabled={!draft.from}
                  onClick={() => {
                    setKind(draft.to ? "range" : "date");
                    setOpen(false);
                    pendingApply.current = true;
                  }}
                  className={cn(
                    "flex h-9 shrink-0 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-foreground",
                    "transition-ui focus-ring hover:bg-brand/90 active:translate-y-px",
                    "disabled:pointer-events-none disabled:opacity-50",
                  )}
                >
                  {t("apply")}
                </button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <a
        href={resetHref}
        title={t("reset")}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-background",
          "text-text-secondary transition-ui focus-ring",
          "hover:border-border-strong hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
        )}
      >
        {/* A reset arrow turns back on itself — it reads the same either way. */}
        <RotateCcw className="size-4" aria-hidden />
        <span className="sr-only">{t("reset")}</span>
      </a>
    </div>
  );
}

function describeDraft(
  draft: { from: string | null; to: string | null },
  locale: string,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  const from = draft.from ? formatDate(new Date(`${draft.from}T00:00:00.000Z`), locale) : "—";
  if (!draft.to) return from;
  const to = formatDate(new Date(`${draft.to}T00:00:00.000Z`), locale);
  return t("activeRange", { from, to });
}

function describeDateFilter(
  value: DateFilterValue,
  locale: string,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  switch (value.range) {
    case "day":
      return t("activeDay");
    case "week":
      return t("activeWeek");
    case "month":
      return t("activeMonth");
    case "date":
      return value.date
        ? formatDate(new Date(`${value.date}T00:00:00.000Z`), locale)
        : t("activeDay");
    case "range": {
      if (!value.from && !value.to) return t("activeRange", { from: "—", to: "—" });
      const from = value.from ? formatDate(new Date(`${value.from}T00:00:00.000Z`), locale) : "—";
      const to = value.to ? formatDate(new Date(`${value.to}T00:00:00.000Z`), locale) : "—";
      return t("activeRange", { from, to });
    }
  }
}
