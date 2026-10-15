"use client";

import { useLocale } from "next-intl";

import { ErrorState } from "@/components/shared/error-state";

/**
 * The print views' error boundary (DES, docs/04 §12). A print sheet has no
 * shell, so beside Retry it offers the way home — the sheet itself is the only
 * thing on the page.
 */
export default function PrintError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = useLocale();
  return <ErrorState error={error} reset={reset} homeHref={`/${locale}`} />;
}
