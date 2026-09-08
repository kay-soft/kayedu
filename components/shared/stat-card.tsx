import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * KPI / stat card — docs/04 §5: white surface, 12px muted label above a large
 * figure, optional trend chip below, optional icon chip and colored top border
 * to differentiate cards in a row.
 *
 * Money figures are never colored here; only the trend chip carries color
 * (▲ success / ▼ danger), per the semantic color rules in docs/04 §2.
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

const ACCENTS = {
  brand: "before:bg-brand",
  success: "before:bg-success",
  warning: "before:bg-warning",
  danger: "before:bg-danger",
  info: "before:bg-info",
} as const;

const TREND_ICONS = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: Minus,
} as const;

function trendTone(trend: StatTrend): string {
  if (trend.direction === "flat") return "bg-surface-subtle text-text-secondary";
  const positive =
    trend.direction === "up" ? !trend.invertColor : Boolean(trend.invertColor);
  return positive ? "bg-success-bg text-success" : "bg-danger-bg text-danger";
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  trend,
  accent,
  zero,
  zeroLabel,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  trend?: StatTrend;
  accent?: keyof typeof ACCENTS;
  /**
   * True when the figure is zero *because nothing happened in this range*,
   * not because something failed. A wall of bold black "EGP 0" reads as a
   * broken screen; a dimmed figure with a one-line reason reads as an answer
   * (docs/04 §5 "KPI / stat card").
   */
  zero?: boolean;
  /** The already-translated "no activity in this range" line. */
  zeroLabel?: string;
  className?: string;
}) {
  const TrendIcon = trend ? TREND_ICONS[trend.direction] : null;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border bg-surface p-4 shadow-card transition-ui hover:border-border-strong hover:shadow-card-hover sm:p-6",
        // The accent is a top border in both locales — a logical inset, so it
        // does not flip with direction (docs/04 §7).
        accent &&
          "before:absolute before:inset-x-0 before:top-0 before:h-1 before:content-['']",
        accent && ACCENTS[accent],
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium text-text-muted">{label}</span>
        {icon ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-text-secondary">
            {icon}
          </span>
        ) : null}
      </div>

      <p
        className={cn(
          "mt-2 text-3xl font-bold tabular-nums",
          zero ? "text-text-muted" : "text-text-primary",
        )}
      >
        {value}
      </p>

      {trend && TrendIcon ? (
        <span
          className={cn(
            "mt-2 inline-flex w-fit items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium",
            trendTone(trend),
          )}
        >
          {/* The arrow means up/down, not forward/back — it must not mirror. */}
          <TrendIcon className="size-3" aria-hidden />
          <span className="tabular-nums">{trend.label}</span>
        </span>
      ) : null}

      {zero && zeroLabel ? (
        <p className="mt-2 text-xs text-text-muted">{zeroLabel}</p>
      ) : null}

      {hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}
