"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { endSessionAction } from "@/app/[locale]/(center)/sessions/actions";
import { ActionBarButton } from "@/components/shared/action-bar";
import { DialogShell } from "@/components/shared/dialog-shell";
import { FormMessage } from "@/components/shared/form-message";
import { IDLE_SESSION_STATE, type SessionActionState } from "@/lib/validation/sessions";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * "End session" (R2) — a button that opens a confirmation dialog saying, in
 * plain words, that ending is permanent: attendance and money lock, enrolled
 * no-shows become Absent, there is no reopen. The dialog's own form submits
 * `endSessionAction` (`session.close`, re-checked server-side). Built to be
 * dropped anywhere a session can be ended — the session detail page now, the
 * reception desk's session cards in R7 — so it takes little but the session id.
 * R6: the button is an `ActionBarButton` (44px, red like every destructive
 * verb) and the confirmation is the shared `DialogShell`.
 *
 * R7: the reception cards reuse this component as it is — one dialog, one
 * action, one copy of "this cannot be undone". `disabled` shows the control
 * but inert (the card says why, before the session starts); `onClosed` lets
 * the reception desk open the receipt once the close has gone through.
 */
export function EndSessionButton({
  sessionId,
  className,
  disabled,
  onClosed,
}: {
  sessionId: string;
  className?: string;
  disabled?: boolean;
  /** Called once, after `endSessionAction` reports the session closed. */
  onClosed?: () => void;
}) {
  const t = useTranslations("Sessions.endSession");
  const tErrors = useTranslations("Sessions.errors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useGuardedActionState(
    async (previous: SessionActionState, formData: FormData) => {
      const next = await endSessionAction(previous, formData);
      if (next.status === "closed") {
        setOpen(false);
        onClosed?.();
      }
      return next;
    },
    IDLE_SESSION_STATE,
  );

  return (
    <>
      <ActionBarButton
        variant="destructive"
        className={className}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Lock className="size-4" aria-hidden />
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
        <div className="flex flex-col gap-3">
          <FormMessage tone="warning">{t("irreversible")}</FormMessage>
          {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
        </div>
      </DialogShell>
    </>
  );
}
