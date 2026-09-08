"use client";

import { ErrorState } from "@/components/shared/error-state";

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
  return (
    <div className="min-h-dvh bg-canvas text-text-primary">
      <ErrorState error={error} reset={reset} />
    </div>
  );
}
