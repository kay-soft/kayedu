"use client";

import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The product's checkbox (docs/04-design-system.md §5 "Checkbox & switch").
 *
 * Replaces the raw `<input type="checkbox" className="accent-[…]">` the
 * permissions matrix and the two class-request forms were using: `accent-color`
 * tints the OS control but leaves its size, radius, focus ring and disabled
 * treatment to the browser, so the densest screen in the product (the
 * permission grid) was drawn by the operating system rather than the design
 * system. Base UI's Checkbox renders the box itself and still posts a real
 * form value from `name`, so no form's payload changes.
 */
function Checkbox({
  className,
  indeterminate,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      indeterminate={indeterminate}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md border border-border-control-hover bg-surface",
        "transition-ui-fast outline-none",
        "hover:border-brand hover:bg-brand/5",
        "focus-visible:ring-3 focus-visible:ring-brand/25 focus-visible:border-brand",
        "data-[checked]:border-brand data-[checked]:bg-brand data-[checked]:text-brand-foreground",
        "data-[indeterminate]:border-brand data-[indeterminate]:bg-brand data-[indeterminate]:text-brand-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {indeterminate ? (
          <Minus className="size-3.5" />
        ) : (
          <Check className="size-3.5" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
