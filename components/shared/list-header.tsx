import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The column-header row of a list-style table (docs/04-design-system.md §5
 * "List"). Below `md` a list is a stack of cards whose own cells carry their
 * labels, so this row is hidden there (and `aria-hidden` — the labels are
 * repeated per card); from `md` it is the table's header, a hairline above
 * the rows.
 *
 * Nine screens carried a copy of this class string, and they had started to
 * drift. The columns' widths stay with the caller — they must match the row
 * cells beneath, which is the part that genuinely differs per list.
 */
export function ListHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <li
      aria-hidden
      className={cn(
        "hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex",
        className,
      )}
    >
      {children}
    </li>
  );
}
