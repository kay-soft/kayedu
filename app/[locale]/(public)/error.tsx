"use client";

import { ErrorState } from "@/components/shared/error-state";

/**
 * The public experience's error boundary (F5): renders inside the public
 * shell, so Explore, the language toggle and Sign in stay usable while one
 * page has failed.
 */
export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} />;
}
