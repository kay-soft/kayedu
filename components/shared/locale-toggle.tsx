"use client";

import { Suspense } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";

import { Link, usePathname } from "@/lib/i18n/navigation";
import { routing } from "@/lib/i18n/routing";
import { cn } from "@/lib/utils";

/**
 * The language toggle (docs/04-design-system.md §5 "Language toggle") — the
 * one and only locale switch in the product. A circular button that shows the
 * code of the language you would *switch to*: "AR" while the UI is English,
 * "EN" while it is Arabic. Two states, so one button, not a dropdown and not
 * a two-segment track that makes you read which half is lit.
 *
 * It navigates to the *same route* in the other locale through next-intl's
 * `Link` (the existing locale-switching mechanism — there is no second one),
 * and carries the query string along, so a filtered Analytics view, a
 * paginated list or a `?next=` return path survives the switch.
 *
 * `useSearchParams` makes a client component bail out of static rendering up
 * to the nearest Suspense boundary, so the query-aware link sits inside one;
 * the fallback is the same button without the query, so there is never a
 * frame with no toggle.
 */
export function LocaleToggle({ className }: { className?: string }) {
  return (
    <Suspense fallback={<ToggleLink query={null} className={className} />}>
      <ToggleWithQuery className={className} />
    </Suspense>
  );
}

function ToggleWithQuery({ className }: { className?: string }) {
  const searchParams = useSearchParams();
  // Rebuilt as a record that keeps repeated keys (`?a=1&a=2`), which
  // `Object.fromEntries` would collapse.
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return <ToggleLink query={query} className={className} />;
}

function ToggleLink({
  query,
  className,
}: {
  query: Record<string, string | string[]> | null;
  className?: string;
}) {
  const t = useTranslations("LocaleToggle");
  const locale = useLocale();
  const pathname = usePathname();

  const target = routing.locales.find((loc) => loc !== locale) ?? routing.defaultLocale;
  const label = t(target === "ar" ? "toArabic" : "toEnglish");

  return (
    <Link
      href={query && Object.keys(query).length > 0 ? { pathname, query } : pathname}
      locale={target}
      hrefLang={target}
      aria-label={label}
      title={label}
      className={cn(
        // 44px hit area around a 36px visual (docs/04 §6).
        "group/toggle inline-flex size-11 shrink-0 items-center justify-center rounded-full focus-ring",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-9 items-center justify-center rounded-full border border-border-strong bg-surface",
          "text-[11px] font-bold tracking-wide text-text-primary shadow-card transition-ui",
          "group-hover/toggle:border-brand group-hover/toggle:bg-brand/10 group-hover/toggle:text-brand",
          "group-active/toggle:scale-95 group-active/toggle:bg-brand/15",
        )}
      >
        {t(target === "ar" ? "codeAr" : "codeEn")}
      </span>
    </Link>
  );
}
