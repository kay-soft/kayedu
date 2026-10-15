import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Status pill — docs/04 §5, §14.1. Semantic colors are fixed:
 * present/paid = success, late/pending = warning, absent/void = danger,
 * upcoming/neutral = info. A role or a kind is never a status: `neutral`.
 *
 * DES: a pill (it had been 8px, the same as a button, so it read as something
 * to press), and the label in the status's darker `-fg` shade so a 12px "Late"
 * passes AA on its tint. `dot` draws a status dot before the label; `pulse`
 * animates it for a live state (stopped by the global reduced-motion rule).
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      variant: {
        neutral: "bg-surface-hover text-text-secondary",
        brand: "bg-brand/10 text-brand",
        success: "bg-success-bg text-success-fg",
        warning: "bg-warning-bg text-warning-fg",
        danger: "bg-danger-bg text-danger-fg",
        info: "bg-info-bg text-info-fg",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

function Badge({
  className,
  variant,
  dot,
  pulse,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { dot?: boolean; pulse?: boolean }) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {dot || pulse ? (
        <span aria-hidden className="relative flex size-1.5 shrink-0">
          {pulse ? (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
          ) : null}
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      ) : null}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
