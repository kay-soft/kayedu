import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // Every state is on the base, so no variant can ship without one
  // (docs/04-design-system.md §5 "Button & link button"): hover and active on
  // each variant below, the one keyboard-only focus ring (§4 — a 2px `--ring`
  // outline 2px off the edge, DES), and a disabled treatment that also kills
  // pointer events so a pending submit cannot be double-fired.
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-ui outline-2 outline-offset-2 outline-transparent select-none focus-visible:outline-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 active:bg-primary/80",
        outline:
          "border-border-control bg-surface shadow-xs hover:border-border-control-hover hover:bg-surface-hover hover:text-foreground active:bg-surface-active aria-expanded:bg-surface-hover aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-surface-hover active:bg-surface-active aria-expanded:bg-surface-hover aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-surface-hover hover:text-foreground active:bg-surface-active aria-expanded:bg-surface-hover aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          // Text in the darker -fg shade so it reads on the tint (DES, §2).
          "bg-destructive/10 text-danger-fg hover:bg-destructive/15 active:bg-destructive/25 focus-visible:outline-danger",
        // The committing action of a destructive confirmation (docs/04 §14.1a):
        // solid, so it outweighs "Keep it". The soft tint above opens it.
        "danger-solid":
          "bg-danger text-white shadow-xs hover:bg-danger-fg active:bg-danger-fg/90 focus-visible:outline-danger",
        link: "text-primary underline-offset-4 hover:underline active:text-primary/80",
      },
      size: {
        // DES (docs/04 §14.1): the default is the 44px touch target — it had
        // been 32px, and most call sites leaned on it. `sm` (36px) is for a
        // secondary verb in a dense desktop row only.
        default: "h-11 gap-2 px-4",
        sm: "h-9 gap-1.5 px-3",
        lg: "h-12 gap-2 px-5 text-base",
        icon: "size-11",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
