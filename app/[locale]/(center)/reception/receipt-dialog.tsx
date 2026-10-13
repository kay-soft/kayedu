"use client";

import { useState } from "react";
import { Printer } from "lucide-react";

import { RECEPTION_SEARCH_INPUT_ID } from "@/app/[locale]/(center)/reception/constants";
import { DialogShell } from "@/components/shared/dialog-shell";
import { LinkButton } from "@/components/shared/link-button";
import { useRouter } from "@/lib/i18n/navigation";

/**
 * A closed session's receipt (R7) in the shared dialog — a full-screen sheet
 * below `md`, a card from there up (`DialogShell`). The receipt inside is R2's
 * `SessionReceipt`, rendered on the server and passed in as `children`; this
 * component only frames it. "Print" opens R2's staff print route
 * (`/sessions/[id]/print`), the same sheet the session page prints. Open state
 * lives in the URL (`?receipt=`), so closing is a soft navigation back to the
 * desk and the keyboard returns to the scan input.
 */
export function ReceiptDialog({
  title,
  description,
  closeHref,
  printHref,
  closeLabel,
  printLabel,
  children,
}: {
  title: string;
  description?: string;
  closeHref: string;
  printHref: string;
  closeLabel: string;
  printLabel: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);

  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          router.replace(closeHref);
          // Radix hands focus back to the opener; the desk wants it on the scan input.
          setTimeout(() => document.getElementById(RECEPTION_SEARCH_INPUT_ID)?.focus(), 0);
        }
      }}
      size="narrow"
      title={title}
      description={description}
      cancelLabel={closeLabel}
      footerExtra={
        <LinkButton href={printHref} target="_blank" className="w-full sm:w-auto">
          <Printer className="size-4" aria-hidden />
          {printLabel}
        </LinkButton>
      }
    >
      {children}
    </DialogShell>
  );
}
