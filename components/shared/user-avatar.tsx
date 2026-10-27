import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-8 text-xs",
  md: "size-9 text-xs",
  lg: "size-16 text-xl",
} as const;

/**
 * A person's avatar (docs/04 §5 "Avatar", F8): their profile photo when the
 * caller has one to show, otherwise their initials. The caller decides whether
 * a photo may appear here — outside the Account page that is
 * `profilePhotoForDisplay()` (`lib/media.ts`, the `MEDIA_AVATARS_DISPLAY`
 * flag) — so this component never reads the flag itself and "off" is simply
 * `photoSrc={null}`.
 */
export function UserAvatar({
  initials,
  photoSrc,
  size = "md",
  className,
}: {
  initials: string;
  photoSrc?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (photoSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- private-media signed delivery, not optimisable by next/image
      <img
        src={photoSrc}
        alt=""
        aria-hidden
        className={cn("shrink-0 rounded-full bg-surface object-cover", SIZES[size], className)}
      />
    );
  }
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
