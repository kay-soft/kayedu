import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The action bar (R6, docs/04-design-system.md §11.15): the row of verbs on a
 * detail page or card — Reschedule, Edit rooms, Cancel, Delete. One pattern so
 * every bar has the same height, spacing and wrapping: a two-column grid on a
 * phone (375px stays two clean columns, never a ragged flow), a wrapping row
 * from `sm`. Every button in it is `ActionBarButton` — 44px, same padding,
 * same type size; a destructive action differs by **colour only**
 * (`variant="destructive"`), never by size.
 */
export function ActionBar({
  children,
  className,
  inHeader,
}: {
  children: ReactNode;
  className?: string;
  /**
   * The bar that sits in a `PageHeader` (R10b): full width below `lg`, and
   * packed to the end edge from `lg`, beside the title (DES, docs/04 §14.1).
   */
  inHeader?: boolean;
}) {
  return (
    <div
      role="group"
      className={cn(
        "grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center",
        // In a detail header it sits beside the title only from lg (DES).
        inHeader && "w-full lg:w-auto lg:justify-end",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ActionBarButton({
  className,
  variant = "outline",
  ...props
}: Omit<ComponentProps<typeof Button>, "size">) {
  return (
    <Button
      type="button"
      variant={variant}
      className={cn("h-11 w-full gap-2 px-4 sm:w-auto", className)}
      {...props}
    />
  );
}
