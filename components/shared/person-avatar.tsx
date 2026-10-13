import { nameInitial } from "@/lib/initials";
import { cn } from "@/lib/utils";

/**
 * A person's mark on a detail-page header (docs/04-design-system.md §5
 * "Avatar"): their photo when there is one, otherwise the first letter of the
 * name as displayed (`lib/initials.ts`). Round, per the shape scale (§4); the
 * initial sits on the neutral subtle surface, not a status colour.
 */
const SIZES = {
  md: "size-12 text-lg",
  lg: "size-16 text-2xl",
} as const;

export function PersonAvatar({
  name,
  photoUrl,
  size = "lg",
  className,
}: {
  name: string;
  /** A short-lived signed Storage URL, or null/undefined for none. */
  photoUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (photoUrl) {
    return (
      // A signed Storage URL, not a static/remote asset next/image can optimize.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoUrl}
        alt=""
        aria-hidden
        className={cn(
          "shrink-0 rounded-full border border-border object-cover",
          SIZES[size],
          className,
        )}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full border border-border bg-surface-subtle font-semibold text-text-secondary",
        SIZES[size],
        className,
      )}
    >
      {nameInitial(name)}
    </span>
  );
}
