import { centerInitial } from "@/lib/initials";
import { cn } from "@/lib/utils";

/**
 * A centre's mark (docs/04-design-system.md §5 "Avatar"): its logo when one is
 * set, otherwise its initial on the centre's own theme colour. Used by the
 * sidebar, the header branch switcher and the centre-selection cards, so all
 * three agree on what a given branch looks like — they previously each did
 * their own thing, and two of them derived the wrong letter (`lib/initials.ts`
 * explains how).
 */
const SIZES = {
  sm: "size-8 text-xs",
  md: "size-9 text-sm",
  lg: "size-11 text-base",
} as const;

export function BrandAvatar({
  name,
  logoUrl,
  themeColor,
  size = "md",
  className,
}: {
  name: string;
  logoUrl?: string | null;
  /** Falls back to the brand token when a centre has not set its own. */
  themeColor?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote centre logos from Supabase Storage
      <img
        src={logoUrl}
        alt=""
        aria-hidden
        className={cn(
          "shrink-0 rounded-lg bg-surface object-cover",
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
        "flex shrink-0 items-center justify-center rounded-lg bg-brand font-bold text-brand-foreground",
        SIZES[size],
        className,
      )}
      style={themeColor ? { backgroundColor: themeColor } : undefined}
    >
      {centerInitial(name)}
    </span>
  );
}
