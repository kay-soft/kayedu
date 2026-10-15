"use client";

import { ArrowLeft, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LinkButton } from "@/components/shared/link-button";

/**
 * On-screen controls for every print view (DES, docs/04 §14.10) — the ID
 * card, the A4 paper record and both session sheets. The way back sits at the
 * start as a ghost arrow (navigation, as on a detail page), Print is the one
 * primary at the end, and the hint says what this particular view prints.
 * It sticks to the top on a long sheet and is hidden from the printout
 * (`print:hidden`), so what comes out of the printer is only the sheet.
 */
export function PrintToolbar({
  backHref,
  backLabel,
  title,
  hint,
  printLabel,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  hint: string;
  printLabel: string;
}) {
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-surface print:hidden">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-8">
        <LinkButton
          href={backHref}
          variant="ghost"
          className="-ms-3 w-fit shrink-0 text-text-secondary hover:text-text-primary"
        >
          <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
          {backLabel}
        </LinkButton>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-text-primary">{title}</h1>
          <p className="text-xs text-text-secondary">{hint}</p>
        </div>

        <Button
          type="button"
          className="w-full shrink-0 sm:w-auto"
          // The browser's own dialog is the print path — no server round-trip,
          // and the user keeps their printer, paper size and margins.
          onClick={() => window.print()}
        >
          <Printer className="size-4" aria-hidden />
          {printLabel}
        </Button>
      </div>
    </div>
  );
}
