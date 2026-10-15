"use client";

import { useLocale } from "next-intl";

import { ErrorState } from "@/components/shared/error-state";
import { PublicHeader } from "@/components/shared/public-header";

/**
 * The locale-level error boundary — the backstop for anything that fails
 * outside an experience's own boundary (a layout's own gate, for instance),
 * where no shell has rendered yet. Same shape as every other error state
 * (docs/04-design-system.md §5).
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = useLocale();
  // The public header (product mark + language) and a way home beside Retry:
  // no shell has rendered here, so nothing else offers one (DES, docs/04 §12).
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-text-primary">
      <PublicHeader />
      <main className="flex-1">
        <ErrorState error={error} reset={reset} homeHref={`/${locale}`} />
      </main>
    </div>
  );
}
