"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "@/lib/utils";

/**
 * The one floating-surface pattern (docs/04-design-system.md §5 "Popover"):
 * the branch switcher, the user menu and the date control all open through
 * this, so a panel that floats over the page looks and animates the same
 * wherever it appears.
 *
 * Wraps Base UI's Popover — already a dependency, like `dialog.tsx` — and
 * opens with the same `data-starting-style`/`data-ending-style` CSS
 * transition the dialog established, so no animation library is introduced.
 *
 * RTL needs no special handling here: `align="start"`/`"end"` are *logical*
 * in Base UI, so a popover anchored to the start edge stays on the start edge
 * in Arabic (docs/04 §7).
 */
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;

function PopoverContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Popup> & {
  side?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["side"];
  align?: React.ComponentProps<typeof PopoverPrimitive.Positioner>["align"];
  sideOffset?: number;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          className={cn(
            "scrollbar-neutral max-h-[min(28rem,var(--available-height))] w-max max-w-[min(22rem,var(--available-width))] overflow-y-auto",
            "rounded-xl border border-border bg-popover p-1 text-sm text-popover-foreground shadow-popover outline-none",
            "origin-(--transform-origin) transition-ui",
            "data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
            "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

/**
 * One row inside a popover panel — a link, a menu item, a submit button.
 * Rendered by the caller's own element (`<a>`, `<button>`), so this is a
 * class string rather than a component: the affordance is shared, the
 * semantics stay the caller's.
 */
const popoverItemClass = cn(
  "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm",
  "text-text-primary transition-ui-fast focus-ring",
  "hover:bg-surface-hover active:bg-surface-active",
  "aria-[current=true]:bg-brand/10 aria-[current=true]:font-medium aria-[current=true]:text-brand",
);

export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose,
  popoverItemClass,
};
