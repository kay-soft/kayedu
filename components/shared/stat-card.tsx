import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * KPI / stat card — docs/04 §5, §14.4: white surface, 12px label above a large
 * figure, optional trend chip below, optional icon chip. Every card is the same
 * neutral surface: there is deliberately no accent colour, because a green or
 * amber top border on "Live now" or "Not started" is decoration borrowing the
 * status palette (docs/04 §2 — semantic colours are for status only).
 *
 * Money figures are never colored here; only the trend chip carries color
 * (▲ success / ▼ danger), per the semantic color rules in docs/04 §2.
 *
 * DES: the label row has a fixed height so figures line up across a row
 * whether or not a card has an icon; a figure never wraps and steps down a size
 * when it is long (a negative Net had dropped its minus sign onto its own
 * line); a zero is drawn in the secondary colour, because an Arabic zero is a
 * single dot and, muted, it disappeared.
 */
export type StatTrend = {
  direction: "up" | "down" | "flat";
  /** Already formatted and localized, e.g. "12.4%". */
  label: string;
  /**
   * Set when a rise is bad news (expenses, absences) so the color follows the
   * meaning rather than the arrow.
   */
  invertColor?: boolean;
};

const TREND_ICONS = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: Minus,
} as const;

/** Past this many characters a figure steps down a size (docs/04 §14.4). */
const LONG_VALUE = 12;

function trendTone(trend: StatTrend): string {
  if (trend.direction === "flat") return "bg-surface-subtle text-text-secondary";
  const positive =
    trend.direction === "up" ? !trend.invertColor : Boolean(trend.invertColor);
  return positive ? "bg-success-bg text-success-fg" : "bg-danger-bg text-danger-fg";
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  trend,
  zero,
  zeroLabel,
  compact,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  trend?: StatTrend;
  /**
   * True when the figure is zero *because nothing happened in this range*,
   * not because something failed. A wall of bold black "EGP 0" reads as a
   * broken screen; a quieter figure with a one-line reason reads as an answer
   * (docs/04 §5 "KPI / stat card").
   */
  zero?: boolean;
  /** The already-translated "no activity in this range" line. */
  zeroLabel?: string;
  /** A short count in a dense row (docs/04 §14.4): less padding, a 24px figure. */
  compact?: boolean;
  className?: string;
}) {
  const TrendIcon = trend ? TREND_ICONS[trend.direction] : null;
  const long = value.length > LONG_VALUE;

  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border border-border bg-surface shadow-card",
        compact ? "p-3 sm:p-4" : "p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex min-h-8 items-start justify-between gap-3">
        <span className="pt-1 text-xs font-medium text-text-secondary">{label}</span>
        {icon ? (
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-text-secondary"
          >
            {icon}
          </span>
        ) : null}
      </div>

      <p
        className={cn(
          "mt-1 font-bold whitespace-nowrap tabular-nums",
          compact ? "text-2xl" : long ? "text-2xl" : "text-2xl sm:text-3xl",
          zero ? "text-text-secondary" : "text-text-primary",
        )}
      >
        {value}
      </p>

      {trend && TrendIcon ? (
        <span
          className={cn(
            "mt-2 inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
            trendTone(trend),
          )}
        >
          {/* The arrow means up/down, not forward/back — it must not mirror. */}
          <TrendIcon className="size-3" aria-hidden />
          <span className="tabular-nums">{trend.label}</span>
        </span>
      ) : null}

      {zero && zeroLabel ? (
        <p className="mt-1.5 text-xs text-text-muted">{zeroLabel}</p>
      ) : null}

      {hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}
