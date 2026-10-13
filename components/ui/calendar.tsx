"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  formatDayOfMonth,
  formatFullDate,
  formatMonthYear,
  formatWeekdayNarrow,
} from "@/lib/format";
import { addDays, dateKey, deviceTodayKey } from "@/lib/scheduling";
import { cn } from "@/lib/utils";

/**
 * The month grid behind every date control in the product
 * (docs/04-design-system.md §5 "Date control"). Replaces `<input type="date">`,
 * whose calendar is drawn by the browser: it ignores the app's locale and
 * direction, renders Latin digits inside an Arabic screen, and looks
 * different in every browser the desk staff happen to be running.
 *
 * All arithmetic is UTC, matching the rest of the product — every stored date
 * is UTC midnight (`lib/scheduling.ts`), and a calendar that quietly used the
 * viewer's timezone would select the wrong day for anyone west of Greenwich.
 * Values in and out are `"YYYY-MM-DD"` strings, so the surrounding form posts
 * exactly what the native input used to post.
 *
 * RTL needs no special case in the grid: the columns are laid out in reading
 * order by CSS, so Arabic fills them right-to-left on its own. Only the
 * previous/next chevrons mirror, because they mean direction (docs/04 §7).
 */

/** Which weekday a calendar week opens on, per locale. Saturday in Egypt. */
const WEEK_START: Record<string, number> = { ar: 6, en: 0 };

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonthsUtc(date: Date, months: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
}

/** The 42 cells (6 weeks) of the grid the given month sits in. */
function monthGrid(month: Date, weekStart: number): Date[] {
  const first = startOfMonthUtc(month);
  const lead = (first.getUTCDay() - weekStart + 7) % 7;
  const origin = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, index) => addDays(origin, index));
}

export type CalendarRange = { from: string | null; to: string | null };

export function Calendar({
  mode,
  value,
  onChange,
  todayIso,
  className,
}: {
  mode: "single" | "range";
  value: CalendarRange;
  onChange: (next: CalendarRange) => void;
  /** Today, computed server-side so it cannot drift from the query's own "now". */
  todayIso: string;
  className?: string;
}) {
  const locale = useLocale();
  const t = useTranslations("Shared.calendar");
  const weekStart = WEEK_START[locale] ?? 0;

  const from = parseIso(value.from);
  const to = parseIso(value.to);
  const today = parseIso(todayIso) ?? parseIso(deviceTodayKey()) ?? new Date(0);

  const [month, setMonth] = React.useState(() =>
    startOfMonthUtc(from ?? today),
  );
  const [hovered, setHovered] = React.useState<string | null>(null);
  // The cell arrow keys move to. Kept as a key, not a ref, so re-rendering a
  // different month cannot leave focus stranded on an unmounted button.
  const [focusKey, setFocusKey] = React.useState<string | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);

  const cells = monthGrid(month, weekStart);
  const weekdayHeaders = cells.slice(0, 7);

  // While a range is half-picked, the cell under the pointer previews the end
  // — the thing that makes a range picker feel like one rather than two
  // separate date fields.
  const previewTo =
    mode === "range" && from && !to && hovered ? parseIso(hovered) : null;
  const rangeStart = from;
  const rangeEnd = to ?? previewTo;
  const [spanStart, spanEnd] =
    rangeStart && rangeEnd && rangeEnd < rangeStart
      ? [rangeEnd, rangeStart]
      : [rangeStart, rangeEnd];

  function select(day: Date) {
    const iso = dateKey(day);
    if (mode === "single") {
      onChange({ from: iso, to: null });
      return;
    }
    if (!from || to) {
      onChange({ from: iso, to: null });
      return;
    }
    // Second click closes the range, in whichever order it was picked.
    onChange(iso < value.from! ? { from: iso, to: value.from } : { from: value.from, to: iso });
  }

  function moveFocus(current: Date, days: number) {
    const next = addDays(current, days);
    if (
      next.getUTCFullYear() !== month.getUTCFullYear() ||
      next.getUTCMonth() !== month.getUTCMonth()
    ) {
      setMonth(startOfMonthUtc(next));
    }
    setFocusKey(dateKey(next));
    // The target button only exists after the month re-renders.
    requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-day="${dateKey(next)}"]`)
        ?.focus();
    });
  }

  const activeKey =
    focusKey ??
    value.from ??
    (dateKey(today).startsWith(dateKey(month).slice(0, 7))
      ? dateKey(today)
      : dateKey(month));

  return (
    <div className={cn("w-[17.5rem] p-2", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setMonth(addMonthsUtc(month, -1))}
          aria-label={t("previousMonth")}
          className="flex size-9 items-center justify-center rounded-lg text-text-secondary transition-ui-fast focus-ring hover:bg-surface-hover active:bg-surface-active"
        >
          {/* Means "back", so it mirrors in RTL (docs/04 §7). */}
          <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden />
        </button>
        <span
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-text-primary"
        >
          {formatMonthYear(month, locale)}
        </span>
        <button
          type="button"
          onClick={() => setMonth(addMonthsUtc(month, 1))}
          aria-label={t("nextMonth")}
          className="flex size-9 items-center justify-center rounded-lg text-text-secondary transition-ui-fast focus-ring hover:bg-surface-hover active:bg-surface-active"
        >
          <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
        </button>
      </div>

      <div aria-hidden className="grid grid-cols-7">
        {weekdayHeaders.map((day) => (
          <span
            key={dateKey(day)}
            className="flex h-7 items-center justify-center text-[11px] font-medium text-text-muted"
          >
            {formatWeekdayNarrow(day, locale)}
          </span>
        ))}
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-label={t("gridLabel")}
        className="grid grid-cols-7"
        onMouseLeave={() => setHovered(null)}
      >
        {cells.map((day) => {
          const key = dateKey(day);
          const outside = day.getUTCMonth() !== month.getUTCMonth();
          const hasSpan =
            spanStart !== null &&
            spanEnd !== null &&
            dateKey(spanStart) !== dateKey(spanEnd);
          const isSpanStart = hasSpan && key === dateKey(spanStart!);
          const isSpanEnd = hasSpan && key === dateKey(spanEnd!);
          const isEndpoint =
            value.from === key || value.to === key || isSpanStart || isSpanEnd;
          const inSpan = hasSpan && day > spanStart! && day < spanEnd!;
          const isToday = key === todayIso;

          return (
            <button
              key={key}
              type="button"
              data-day={key}
              role="gridcell"
              tabIndex={key === activeKey ? 0 : -1}
              aria-selected={isEndpoint || inSpan}
              aria-label={formatFullDate(day, locale)}
              onClick={() => select(day)}
              onMouseEnter={() => setHovered(key)}
              onFocus={() => setFocusKey(key)}
              onKeyDown={(event) => {
                const step =
                  event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowLeft"
                      ? -1
                      : event.key === "ArrowDown"
                        ? 7
                        : event.key === "ArrowUp"
                          ? -7
                          : event.key === "PageDown"
                            ? 28
                            : event.key === "PageUp"
                              ? -28
                              : 0;
                if (step === 0) return;
                event.preventDefault();
                // Left/Right are physical keys on a physical keyboard: in a
                // right-to-left grid, "right" is the earlier day.
                const rtl = document.documentElement.dir === "rtl";
                const horizontal = Math.abs(step) === 1;
                moveFocus(day, horizontal && rtl ? -step : step);
              }}
              className={cn(
                "relative flex h-10 items-center justify-center text-sm tabular-nums transition-ui-fast focus-ring",
                "hover:bg-surface-hover",
                outside ? "text-text-muted/60" : "text-text-primary",
                // The span between the two ends reads as one continuous band:
                // the cells inside it square off, and only its two ends round.
                inSpan && "bg-brand/10 text-brand",
                isEndpoint &&
                  "bg-brand font-semibold text-brand-foreground hover:bg-brand",
                isSpanStart && "rounded-s-lg",
                isSpanEnd && "rounded-e-lg",
                !hasSpan && "rounded-lg",
              )}
            >
              {formatDayOfMonth(day, locale)}
              {isToday && !isEndpoint ? (
                <span
                  aria-hidden
                  className="absolute bottom-1 size-1 rounded-full bg-brand"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
