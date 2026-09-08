"use client";

import { ErrorState } from "@/components/shared/error-state";

/**
 * The teacher portal error boundary (docs/04-design-system.md §5 "Error state").
 * Renders inside this experience's shell, so the sidebar, the branch context
 * and the language toggle all stay usable while one screen has failed —
 * a failed page is not a reason to strand someone with no navigation.
 */
export default function TeacherError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState error={error} reset={reset} />;
}
