import type { ComponentProps } from "react";

import { buttonVariants } from "@/components/ui/button";
import { Link } from "@/lib/i18n/navigation";
import { cn } from "@/lib/utils";

/**
 * A link that acts as a button (docs/04-design-system.md §5 "Button & link
 * button"). Twenty-five screens had hand-written this as a bare `<Link>` with
 * a copied class string — each one slightly different, none of them with a
 * `focus-visible` ring or a pressed state, so the most common navigation
 * affordance in the ERP was the one control a keyboard user could not see.
 *
 * Same variants and sizes as `Button`, so "Open" beside a "Deactivate" button
 * lines up on the same baseline with the same height in every list row. The
 * default size is `touch` — 44px, the desk minimum from §6 — because these
 * sit in table rows and toolbars that get used on a phone.
 */
const SIZES = {
  touch: "h-11 px-4",
  sm: "h-9 px-3 text-[0.8rem]",
  icon: "size-11 p-0",
} as const;

type LinkButtonProps = ComponentProps<typeof Link> & {
  variant?: NonNullable<Parameters<typeof buttonVariants>[0]>["variant"];
  size?: keyof typeof SIZES;
};

export function LinkButton({
  variant = "outline",
  size = "touch",
  className,
  ...props
}: LinkButtonProps) {
  return (
    <Link
      className={cn(
        buttonVariants({ variant }),
        SIZES[size],
        "gap-2 whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The same treatment for a plain `<a>` — the handful of places that must do a
 * full document navigation (a locale-prefixed href built by hand, a print
 * view) rather than a client-side route change.
 */
export function AnchorButton({
  variant = "outline",
  size = "touch",
  className,
  ...props
}: ComponentProps<"a"> & {
  variant?: NonNullable<Parameters<typeof buttonVariants>[0]>["variant"];
  size?: keyof typeof SIZES;
}) {
  return (
    <a
      className={cn(
        buttonVariants({ variant }),
        SIZES[size],
        "gap-2 whitespace-nowrap",
        className,
      )}
      {...props}
    />
  );
}
