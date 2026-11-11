"use client";

import { ErrorState } from "@/components/shared/error-state";

/**
 * The assistant experience's error boundary (W7a; docs/04-design-system.md §5
 * "Error state") — a failed screen keeps a way out.
 */
export default function AssistantError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} />;
}
