import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-24 w-full min-w-0 rounded-lg border border-border-control bg-surface px-3 py-2 text-sm text-foreground shadow-xs transition-ui outline-none hover:border-border-control-hover",
        "placeholder:text-text-placeholder",
        "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        // Read-only looks read-only (an invitation's fixed email), DES §14.1.
        "read-only:bg-surface-subtle read-only:text-text-secondary read-only:hover:border-border-control",
        "aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
