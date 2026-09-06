import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A native `<select>` styled to match Input (docs/04 §4/§6): 8px radius,
 * 44px min touch target, brand focus ring. Native on purpose — it gives the
 * correct mobile picker and needs no client JS.
 */
function SelectInput({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select-input"
      className={cn(
        "h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground shadow-xs transition-colors outline-none",
        "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20",
        className,
      )}
      {...props}
    />
  );
}

export { SelectInput };
