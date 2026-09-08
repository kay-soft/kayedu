"use client";

import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LinkButton } from "@/components/shared/link-button";

/** On-screen-only print controls — hidden from the printout (`print:hidden`). */
export function TeacherSessionPrintToolbar({
  title,
  hint,
  printLabel,
  backLabel,
  backHref,
}: {
  title: string;
  hint: string;
  printLabel: string;
  backLabel: string;
  backHref: string;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border bg-surface px-4 py-3 print:hidden sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold text-text-primary">{title}</h1>
        <p className="text-xs text-text-muted">{hint}</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button type="button" className="h-11 px-4" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden />
          {printLabel}
        </Button>
        <LinkButton href={backHref}>
          {backLabel}
        </LinkButton>
      </div>
    </div>
  );
}
