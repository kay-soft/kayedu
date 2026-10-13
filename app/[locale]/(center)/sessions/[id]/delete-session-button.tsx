"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { deleteSessionAction } from "@/app/[locale]/(center)/sessions/actions";
import { ActionBarButton } from "@/components/shared/action-bar";
import { DialogShell } from "@/components/shared/dialog-shell";
import { FormMessage } from "@/components/shared/form-message";
import { IDLE_SESSION_STATE } from "@/lib/validation/sessions";

/**
 * "Delete session" (R5) — offered only for a manual or one-time session that
 * has not started and has nothing on it (the page asks the data layer,
 * `manualSessionDeleteState`). Behind a confirmation; the action re-checks
 * everything under a row lock and refuses by direct call otherwise, and on
 * success leaves for the Sessions list. R6: a button of the page's
 * `ActionBar` (same size as Reschedule/Cancel, red) and the confirmation is
 * the shared `DialogShell`.
 */
export function DeleteSessionButton({ sessionId }: { sessionId: string }) {
  const t = useTranslations("Sessions.deleteSession");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(deleteSessionAction, IDLE_SESSION_STATE);

  return (
    <>
      <ActionBarButton variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 className="size-4" aria-hidden />
        {t("button")}
      </ActionBarButton>
      {state.error && !open ? (
        <div className="col-span-2 sm:basis-full">
          <FormMessage>{tErrors(state.error)}</FormMessage>
        </div>
      ) : null}

      <DialogShell
        open={open}
        onOpenChange={setOpen}
        size="narrow"
        title={t("dialogTitle")}
        description={t("dialogBody")}
        formProps={{ action: formAction }}
        cancelLabel={t("cancel")}
        submitLabel={t("confirm")}
        submitVariant="destructive"
        submitPending={pending}
      >
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="sessionId" value={sessionId} />
        {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      </DialogShell>
    </>
  );
}
