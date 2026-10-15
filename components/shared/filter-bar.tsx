import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The one filter-row pattern (docs/04-design-system.md §5 "Filter row").
 *
 * Every list and report screen filters with the same shape: a plain GET form
 * (filter state lives in the URL, §11.7), a row of labelled fields that wraps
 * instead of scrolling, and every control 44px tall and bottom-aligned, so a
 * select, a date control and a reset button share one baseline whatever the
 * label above them is. Below `sm` the fields stack, each full width.
 *
 * Each `FilterField` carries its own visible label — the label is what lets
 * the controls align (a label-less control beside a labelled one floats half
 * a line off), and it is what a screen-reader user needs anyway.
 */
export function FilterBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <form
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-3 sm:gap-y-4",
        className,
      )}
    >
      {children}
    </form>
  );
}

export function FilterField({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  /** The control's id, when it has one. */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium text-text-secondary"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
