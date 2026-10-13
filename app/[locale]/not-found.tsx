import { FileQuestion } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { AnchorButton } from "@/components/shared/link-button";
import { LocaleToggle } from "@/components/shared/locale-toggle";

/**
 * The 404 (docs/04-design-system.md §5 "Empty state"). It renders outside
 * every experience shell — a not-found route has no resolved centre, so
 * there is no sidebar to draw — which is why it carries its own minimal
 * chrome and points at `/`, the entry point that re-resolves the user's own
 * home screen (`app/[locale]/page.tsx`) rather than guessing at one here.
 */
export default async function NotFound() {
  const locale = await getLocale();
  const t = await getTranslations("Shared.notFound");
  const tShell = await getTranslations("Shell");

  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-text-primary">
      <header className="flex items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-brand-foreground"
          >
            K
          </span>
          <span className="text-sm font-semibold">{tShell("productName")}</span>
        </span>
        <LocaleToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-full bg-surface-subtle text-text-muted"
          >
            <FileQuestion className="size-6" />
          </span>
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-text-primary">
              {t("title")}
            </h1>
            <p className="text-sm text-text-secondary">{t("description")}</p>
          </div>
          <AnchorButton href={`/${locale}`} variant="default">
            {t("home")}
          </AnchorButton>
        </div>
      </main>
    </div>
  );
}
