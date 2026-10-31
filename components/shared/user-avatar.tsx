import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-8 text-xs",
  md: "size-9 text-xs",
  lg: "size-16 text-xl",
} as const;

/**
 * A person's avatar (docs/04 §5 "Avatar"): their initials. Since U9 nobody has
 * a personal profile photo — only teachers have photos, per branch, and those
 * show through `PersonAvatar` — so this is the monogram and nothing else.
 */
export function UserAvatar({
  initials,
  size = "md",
  className,
}: {
  initials: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-surface font-semibold text-text-primary",
        SIZES[size],
        className,
      )}
    >
      {initials}
    </span>
  );
}
