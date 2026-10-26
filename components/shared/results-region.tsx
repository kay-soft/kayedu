"use client";

import type { ReactNode } from "react";

import { useUrlPending } from "@/lib/ui/url-pending";
import { cn } from "@/lib/utils";

/**
 * The part of a page a filter, date, tab or pager replaces
 * (docs/04-design-system.md §5 "Filter row", pending state).
 *
 * While a URL-state navigation is in flight the old results stay in place,
 * dimmed, and `aria-busy` tells assistive technology they are about to change.
 * Opacity only — no skeleton swap, no height change, so nothing under it moves.
 * The filter controls themselves sit outside the region and stay fully live.
 */
export function ResultsRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const pending = useUrlPending();

  return (
    <div
      aria-busy={pending}
      className={cn(
        "transition-opacity duration-(--motion-fast)",
        pending && "opacity-60",
        className,
      )}
    >
      {children}
    </div>
  );
}
