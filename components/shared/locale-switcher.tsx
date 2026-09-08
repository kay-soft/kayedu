"use client";

import { useLocale, useTranslations } from "next-intl";

import { Link, usePathname } from "@/lib/i18n/navigation";
import { routing } from "@/lib/i18n/routing";
import { cn } from "@/lib/utils";

/**
 * The language toggle (docs/04-design-system.md §5 "App bar"). Two states, so
 * it is a segmented control rather than a dropdown — the fastest possible
 * switch for the thing a bilingual desk does several times a day.
 *
 * It used to render as `Language: ar en` — a label plus two loose text links
 * with no shared frame, which read as leftover markup beside the header's
 * other controls. The label is now the accessible name of the group, and the
 * control itself is a track with a filled active segment.
 */
export function LocaleSwitcher() {
  const t = useTranslations("LocaleSwitcher");
  const locale = useLocale();
  const pathname = usePathname();

  return (
    <div
      role="group"
      aria-label={t("label")}
      className="flex h-11 shrink-0 items-center gap-0.5 rounded-lg border border-border bg-surface-subtle p-0.5"
    >
      {routing.locales.map((loc) => (
        <Link
          key={loc}
          href={pathname}
          locale={loc}
          aria-current={loc === locale ? "true" : undefined}
          className={cn(
            "flex h-full min-w-11 items-center justify-center rounded-md px-2 text-sm font-medium",
            "transition-ui focus-ring",
            loc === locale
              ? "bg-surface text-text-primary shadow-card"
              : "text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-active",
          )}
        >
          {t(loc)}
        </Link>
      ))}
    </div>
  );
}
