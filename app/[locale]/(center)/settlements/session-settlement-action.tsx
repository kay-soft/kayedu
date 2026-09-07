"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { createSessionSettlementAction } from "@/app/[locale]/(center)/settlements/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_SETTLEMENT_STATE } from "@/lib/validation/settlements";

/**
 * The "pay cash right after this session" shape from the session detail page
 * itself (spec §5 "Teacher settlements") — only rendered when this session
 * has no settlement yet (docs/00 §4.1 item 11's other scope, the period
 * roll-up, lives at `/settlements`).
 */
export function SessionSettlementAction({ sessionId }: { sessionId: string }) {
  const t = useTranslations("Settlements");
  const tErrors = useTranslations("Settlements.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(
    createSessionSettlementAction,
    IDLE_SETTLEMENT_STATE,
  );

  if (state.status === "created") {
    return <FormMessage tone="success">{t("sessionSettled")}</FormMessage>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="sessionId" value={sessionId} />
      {state.error ? <FormMessage className="text-xs">{tErrors(state.error)}</FormMessage> : null}
      <SubmitButton variant="outline" className="w-full">
        {t("settleThisSession")}
      </SubmitButton>
    </form>
  );
}
