import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * An empty region, designed (docs/04-design-system.md §5 "Empty state").
 *
 * The product had thirty-odd of these written as a single dimmed sentence
 * floating in a card, which reads as a screen that failed to load rather than
 * a screen with nothing in it yet. One shape, everywhere: an icon in a tinted
 * chip, a short title naming the absence, a line explaining what *would*
 * appear here, and — when the screen has one — the action that creates the
 * first item.
 *
 * `tone` carries meaning, not decoration: `info` for "nothing here yet",
 * `warning` for "nothing matched what you asked for" (something is filtered),
 * and `muted` for a secondary panel that should not compete with the primary
 * content beside it.
 */
const TONES = {
  muted: "bg-surface-subtle text-text-muted",
  info: "bg-info-bg text-info-fg",
  warning: "bg-warning-bg text-warning-fg",
  success: "bg-success-bg text-success-fg",
} as const;

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "muted",
  compact,
  className,
}: {
  /** A lucide icon element, already sized by the caller or left to default. */
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: keyof typeof TONES;
  /** For a panel inside a card that already has its own heading. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // DES (docs/04 §14.1): no dashed box — the card around it is the
        // frame; a compact panel sits on a quiet inset instead.
        "flex flex-col items-center justify-center gap-3 rounded-xl text-center",
        compact ? "bg-surface-subtle px-4 py-6" : "px-6 py-10 sm:py-14",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden
          className={cn(
            "flex size-11 items-center justify-center rounded-full [&_svg]:size-5",
            TONES[tone],
          )}
        >
          {icon}
        </span>
      ) : null}

      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        {description ? (
          <p className="text-sm text-pretty text-text-secondary">{description}</p>
        ) : null}
      </div>

      {action ? <div className="mt-1 w-full sm:w-auto">{action}</div> : null}
    </div>
  );
}
