"use client";

import { ErrorState } from "@/components/shared/error-state";

/**
 * The signed-out error boundary (docs/04-design-system.md §5 "Error state").
 * The language toggle in the auth layout above stays available, so someone
 * who hit this in the wrong language can still switch and retry.
 */
export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} />;
}
