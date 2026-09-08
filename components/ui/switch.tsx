"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

/**
 * A boolean *setting* (docs/04-design-system.md §5 "Checkbox & switch"): a
 * switch reads as "this is on now", where a checkbox reads as "this will be
 * true when I save". The configuration screens' `ToggleRow` uses this; the
 * permission matrix — which explicitly saves on an Apply button — keeps the
 * checkbox.
 *
 * Posts the same form value a checkbox would (`name` + present-when-on), so
 * the Server Actions reading these settings are untouched. The thumb travels
 * on a logical inset, so it slides toward the end edge in both directions
 * (docs/04 §7).
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full border border-border-strong bg-surface-active",
        "transition-ui outline-none",
        "hover:border-brand/50",
        "focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:border-brand",
        "data-[checked]:border-brand data-[checked]:bg-brand",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "absolute top-1/2 size-[18px] -translate-y-1/2 rounded-full bg-white shadow-card",
          "transition-[inset-inline-start] duration-[var(--motion-base)] ease-[var(--ease-out)]",
          // A logical inset, so the thumb slides toward the end edge in
          // Arabic exactly as it does in English (docs/04 §7).
          "start-[2px] data-[checked]:start-[22px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
