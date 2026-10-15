"use client";

import { RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { AnchorButton } from "@/components/shared/link-button";
import { Button } from "@/components/ui/button";

/**
 * What a route's `error.tsx` renders (docs/04-design-system.md §5 "Error
 * state"). One shape for every experience: say what happened in the
 * interface's own voice, offer the retry that React's error boundary already
 * gives us, and — in development only — show the message so the failure is
 * debuggable without opening the console.
 *
 * Deliberately does not apologise or blame the user. It also never renders
 * the raw error in production: an ORM error string can name a table, a column
 * or an id from another tenant.
 */
export function ErrorState({
  error,
  reset,
  homeHref,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /**
   * A way out beside Retry (DES, docs/04 §12): where the failure is a
   * layout's own gate, retrying fails again.
   */
  homeHref?: string;
}) {
  const t = useTranslations("Shared.error");

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full bg-danger-bg text-danger-fg"
      >
        <TriangleAlert className="size-6" />
      </span>

      <div className="flex max-w-md flex-col gap-1">
        <h1 className="text-lg font-semibold text-text-primary">
          {t("title")}
        </h1>
        <p className="text-sm text-text-secondary">{t("description")}</p>
      </div>

      <div className="grid w-full max-w-xs gap-2 sm:flex sm:w-auto sm:max-w-none">
        <Button onClick={reset}>
          <RefreshCw className="size-4" aria-hidden />
          {t("retry")}
        </Button>
        {homeHref ? <AnchorButton href={homeHref}>{t("home")}</AnchorButton> : null}
      </div>

      {process.env.NODE_ENV === "development" ? (
        <pre
          dir="ltr"
          className="max-w-full overflow-x-auto rounded-lg bg-surface-subtle p-3 text-start text-xs text-text-secondary"
        >
          {error.message}
          {error.digest ? `\n\ndigest: ${error.digest}` : ""}
        </pre>
      ) : null}
    </div>
  );
}
