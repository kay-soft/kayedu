import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A KPI row whose column count is chosen for the number of cards in it
 * (docs/04-design-system.md §5 "KPI grid").
 *
 * Every KPI row in the product used the same `sm:grid-cols-2 xl:grid-cols-4`
 * regardless of how many cards it held, so Analytics' seven revenue cards
 * wrapped to a four-wide grid and left an orphan row of three, and its five
 * user cards left an orphan of one. A grid is a composition, not a default:
 * this picks the arrangement that divides evenly at each breakpoint, and a
 * page that needs a different split says so by rendering two rows.
 *
 * Above five cards there is no arrangement that divides cleanly at every
 * breakpoint — that is the signal to split the row by meaning instead, which
 * is what the Analytics page now does.
 */
const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
  5: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  6: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
};

export function StatGrid({
  count,
  children,
  className,
}: {
  /** How many cards this row holds — the callers know it statically. */
  count: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        COLUMNS[count] ?? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
