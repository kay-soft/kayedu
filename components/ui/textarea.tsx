import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-24 w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-xs transition-colors outline-none",
        "placeholder:text-muted-foreground",
        "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
