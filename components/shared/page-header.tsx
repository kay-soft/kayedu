import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The page header every screen opens with (docs/04-design-system.md §5 "Page
 * header"): a 24px/700 title, an optional one-line description under it, and
 * the page's actions on the end edge.
 *
 * Below `sm` the actions drop under the title and wrap, so a header with two
 * buttons never pushes the title into a sliver at 375px. Actions are passed
 * as a node — a `LinkButton`, a dialog trigger, a badge — and are laid out
 * here, so no page hand-rolls its own flex row beside the title.
 */
export function PageHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl leading-tight font-bold text-balance text-text-primary">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-prose text-sm text-text-secondary">
            {description}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {action}
        </div>
      ) : null}
    </div>
  );
}
