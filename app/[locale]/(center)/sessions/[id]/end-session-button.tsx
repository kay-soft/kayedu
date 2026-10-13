"use client";

import { useActionState, useState } from "react";
import { Lock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { endSessionAction } from "@/app/[locale]/(center)/sessions/actions";
import { ActionBarButton } from "@/components/shared/action-bar";
import { DialogShell } from "@/components/shared/dialog-shell";
import { FormMessage } from "@/components/shared/form-message";
import { IDLE_SESSION_STATE, type SessionActionState } from "@/lib/validation/sessions";

/**
 * "End session" (R2) — a button that opens a confirmation dialog saying, in
 * plain words, that ending is permanent: attendance and money lock, enrolled
 * no-shows become Absent, there is no reopen. The dialog's own form submits
 * `endSessionAction` (`session.close`, re-checked server-side). Built to be
 * dropped anywhere a session can be ended — the session detail page now, the
 * reception desk's live rail in R7 — so it takes nothing but the session id.
 * R6: the button is an `ActionBarButton` (44px, red like every destructive
 * verb) and the confirmation is the shared `DialogShell`.
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
  const [state, formAction, pending] = useActionState(
    async (previous: SessionActionState, formData: FormData) => {
      const next = await endSessionAction(previous, formData);
      if (next.status === "closed") setOpen(false);
      return next;
    },
    IDLE_SESSION_STATE,
  );

  return (
    <>
      <ActionBarButton variant="destructive" className={className} onClick={() => setOpen(true)}>
        <Lock className="size-4" aria-hidden />
        {t("button")}
      </ActionBarButton>
      {state.error && !open ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

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
        <div className="flex flex-col gap-3">
          <FormMessage tone="warning">{t("irreversible")}</FormMessage>
          {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
        </div>
      </DialogShell>
    </>
  );
}
