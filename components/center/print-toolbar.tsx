"use client";

import { Printer } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Link } from "@/lib/i18n/navigation";

/**
 * On-screen controls for a print view. Hidden from the printout itself
 * (`print:hidden`), so what comes out of the printer is only the card or the
 * sheet — no chrome, no buttons.
 */
export function PrintToolbar({
  backHref,
  title,
}: {
  backHref: string;
  title: string;
}) {
  const t = useTranslations("Students.print");

  return (
    <div className="flex flex-col gap-3 border-b border-border bg-surface px-4 py-3 print:hidden sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold text-text-primary">
          {title}
        </h1>
        <p className="text-xs text-text-muted">{t("hint")}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          type="button"
          className="h-11 px-4"
          // The browser's own dialog is the print path — no server round-trip,
          // and the user keeps their printer, paper size and margins.
          onClick={() => window.print()}
        >
          <Printer className="size-4" aria-hidden />
          {t("print")}
        </Button>

        <Link
          href={backHref}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm text-text-secondary hover:bg-surface-subtle"
        >
          {t("back")}
        </Link>
      </div>
    </div>
  );
}
