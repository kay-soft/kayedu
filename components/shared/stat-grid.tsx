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
 * Every arrangement here fills its rows at 375, 768 and 1280: where the
 * column count does not divide the card count, the last card spans the
 * remainder rather than leaving a hole. Above six cards there is no
 * arrangement that divides cleanly — split the row by meaning instead, which
 * is what the Analytics page does.
 */
const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  // 2 columns from `sm` would strand the third card; it spans the full row
  // there instead, then settles into three across from `lg`.
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 sm:[&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1",
  4: "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
  // Five divides evenly nowhere, so each wide step is built from a six-column
  // track: 2+2+1 at `sm` (the last spans the row), 3 over 2 at `lg`, five
  // across at `xl`.
  5: "grid-cols-1 sm:grid-cols-2 sm:[&>*:last-child]:col-span-2 lg:grid-cols-6 lg:[&>*]:col-span-2 lg:[&>*:nth-child(n+4)]:col-span-3 xl:grid-cols-5 xl:[&>*]:col-span-1 xl:[&>*:nth-child(n+4)]:col-span-1",
  6: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
};

/**
 * DES (docs/04 §14.4): a row of short counts is two up from the smallest phone
 * — a lone "3" no longer takes a full-width card — and the third of three
 * spans its row there; three or four across from `sm` / `xl`.
 */
const DENSE: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1",
  4: "grid-cols-2 xl:grid-cols-4",
};

export function StatGrid({
  count,
  dense,
  children,
  className,
}: {
  /** How many cards this row holds — the callers know it statically. */
  count: number;
  /** Short counts (not money): two up on a phone. */
  dense?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid",
        dense ? "gap-3 sm:gap-4" : "gap-4",
        (dense ? DENSE[count] : undefined) ?? COLUMNS[count] ?? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
