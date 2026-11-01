import { ImageOff } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A 16:9 preview of the picture a class card shows (U9) — the cover, else the
 * teacher's photo — with a quiet empty tile when there is neither (the card
 * then falls back to its generated look). `src` is a signing-route path, never
 * a storage key. `emptyLabel` is already translated.
 */
export function ImagePreview({
  src,
  emptyLabel,
  className,
}: {
  src: string | null;
  emptyLabel: string;
  className?: string;
}) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- private-media signing route, not optimisable by next/image
      <img
        src={src}
        alt=""
        className={cn("aspect-[16/9] w-full max-w-sm rounded-xl border border-border bg-surface-subtle object-cover object-top", className)}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex aspect-[16/9] w-full max-w-sm flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-surface-subtle p-3 text-center text-xs text-text-muted",
        className,
      )}
    >
      <ImageOff className="size-5" aria-hidden />
      {emptyLabel}
    </div>
  );
}
