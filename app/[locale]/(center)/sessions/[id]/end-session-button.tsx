"use client";

import { useActionState, useState } from "react";
import { Lock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { endSessionAction } from "@/app/[locale]/(center)/sessions/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IDLE_SESSION_STATE, type SessionActionState } from "@/lib/validation/sessions";

/**
 * "End session" (R2) — a button that opens a confirmation dialog saying, in
 * plain words, that ending is permanent: attendance and money lock, enrolled
 * no-shows become Absent, there is no reopen. The dialog's own form submits
 * `endSessionAction` (`session.close`, re-checked server-side). Built to be
 * dropped anywhere a session can be ended — the session detail page now, the
 * reception desk's live rail in R7 — so it takes nothing but the session id.
 */
export function EndSessionButton({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const t = useTranslations("Sessions.endSession");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(
    async (previous: SessionActionState, formData: FormData) => {
      const next = await endSessionAction(previous, formData);
      if (next.status === "closed") setOpen(false);
      return next;
    },
    IDLE_SESSION_STATE,
  );

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        className={className ?? "h-11 px-4"}
        onClick={() => setOpen(true)}
      >
        <Lock className="size-4" aria-hidden />
        {t("button")}
      </Button>
      {state.error && !open ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form action={formAction} className="flex flex-1 flex-col">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="sessionId" value={sessionId} />
            <DialogHeader>
              <DialogTitle>{t("dialogTitle")}</DialogTitle>
              <DialogDescription>{t("dialogBody")}</DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-3">
              <FormMessage tone="warning">{t("irreversible")}</FormMessage>
              {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11 px-4"
                onClick={() => setOpen(false)}
              >
                {t("cancel")}
              </Button>
              <SubmitButton variant="destructive">{t("confirm")}</SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
