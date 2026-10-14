"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { SettlementStatus } from "@prisma/client";

import {
  approveSettlementAction,
  cancelSettlementAction,
  paySettlementAction,
} from "@/app/[locale]/(center)/settlements/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_SETTLEMENT_STATE } from "@/lib/validation/settlements";

/**
 * DRAFT → APPROVED → PAID, one button at a time (spec §5 "Teacher
 * settlements": no partially-paid state, and every transition is
 * permissioned and audited server-side — this only hides the button for a
 * status that has nothing left to do). A DRAFT can also be **cancelled**
 * (D-16), which releases the payments it claimed. `ownBlocked` (D-12): the
 * viewer created this settlement and is not an OWNER, so approving or paying
 * it needs someone else — the hint says so, and the server refuses anyway.
 */
export function SettlementTransitionActions({
  id,
  status,
  ownBlocked,
}: {
  id: string;
  status: SettlementStatus;
  ownBlocked: boolean;
}) {
  const t = useTranslations("Settlements");
  const tErrors = useTranslations("Settlements.errors");
  const locale = useLocale();

  const [approveState, approveAction] = useActionState(
    approveSettlementAction,
    IDLE_SETTLEMENT_STATE,
  );
  const [payState, payAction] = useActionState(paySettlementAction, IDLE_SETTLEMENT_STATE);
  const [cancelState, cancelAction] = useActionState(cancelSettlementAction, IDLE_SETTLEMENT_STATE);

  const effectiveStatus =
    cancelState.status === "cancelled"
      ? "CANCELLED"
      : payState.status === "paid"
        ? "PAID"
        : approveState.status === "approved"
          ? "APPROVED"
          : status;
  const error = approveState.error ?? payState.error ?? cancelState.error;

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      {error ? <FormMessage className="text-xs">{tErrors(error)}</FormMessage> : null}
      {ownBlocked && (effectiveStatus === "DRAFT" || effectiveStatus === "APPROVED") ? (
        <p className="text-xs text-text-muted">{t("ownSettlementHint")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2 sm:justify-end">
        {effectiveStatus === "DRAFT" ? (
          <>
            <form action={cancelAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="id" value={id} />
              <SubmitButton variant="ghost">{t("cancelDraft")}</SubmitButton>
            </form>
            {ownBlocked ? null : (
              <form action={approveAction}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="id" value={id} />
                <SubmitButton variant="outline">{t("approve")}</SubmitButton>
              </form>
            )}
          </>
        ) : effectiveStatus === "APPROVED" && !ownBlocked ? (
          <form action={payAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="id" value={id} />
            <SubmitButton>{t("markPaid")}</SubmitButton>
          </form>
        ) : null}
      </div>
    </div>
  );
}
