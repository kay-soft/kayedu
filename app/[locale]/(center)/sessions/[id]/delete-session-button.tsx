"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { deleteSessionAction } from "@/app/[locale]/(center)/sessions/actions";
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
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";

/**
 * "Delete session" (R5) — offered only for a manual or one-time session that
 * has not started and has nothing on it (the page asks the data layer,
 * `manualSessionDeleteState`). Behind a confirmation; the action re-checks
 * everything under a row lock and refuses by direct call otherwise, and on
 * success leaves for the Sessions list.
 */
export function DeleteSessionButton({ sessionId }: { sessionId: string }) {
  const t = useTranslations("Sessions.deleteSession");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(deleteSessionAction, IDLE_SESSION_STATE);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 px-3 text-xs text-danger"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" aria-hidden />
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
              {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" className="h-11 px-4" onClick={() => setOpen(false)}>
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
