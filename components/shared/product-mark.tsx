import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * The product's own mark — the brand tile and the product name, drawn once
 * (docs/04-design-system.md §12 "DES additions"). The auth panel, the auth
 * header and the 404 had each hand-drawn their own "K" tile. A centre's own
 * mark is `BrandAvatar`; this is KayEdu's, for screens outside a centre.
 */
export function ProductMark({
  size = "md",
  inverse,
  className,
}: {
  size?: "md" | "lg";
  /** On the dark auth panel. */
  inverse?: boolean;
  className?: string;
}) {
  const t = useTranslations("Shell");

  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span
        aria-hidden
        className={cn(
          "flex items-center justify-center bg-brand font-bold text-brand-foreground",
          size === "lg" ? "size-10 rounded-xl text-base" : "size-8 rounded-lg text-sm",
        )}
      >
        K
      </span>
      <span
        className={cn(
          "font-semibold",
          size === "lg" ? "text-lg" : "text-sm",
          inverse ? "text-white" : "text-text-primary",
        )}
      >
        {t("productName")}
      </span>
    </span>
  );
}
