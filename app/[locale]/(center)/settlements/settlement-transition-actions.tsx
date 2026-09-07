"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { SettlementStatus } from "@prisma/client";

import {
  approveSettlementAction,
  paySettlementAction,
} from "@/app/[locale]/(center)/settlements/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_SETTLEMENT_STATE } from "@/lib/validation/settlements";

/**
 * DRAFT → APPROVED → PAID, one button at a time (spec §5 "Teacher
 * settlements": no partially-paid state, and every transition is
 * permissioned and audited server-side — this only hides the button for a
 * status that has nothing left to do).
 */
export function SettlementTransitionActions({
  id,
  status,
}: {
  id: string;
  status: SettlementStatus;
}) {
  const t = useTranslations("Settlements");
  const tErrors = useTranslations("Settlements.errors");
  const locale = useLocale();

  const [approveState, approveAction] = useActionState(
    approveSettlementAction,
    IDLE_SETTLEMENT_STATE,
  );
  const [payState, payAction] = useActionState(paySettlementAction, IDLE_SETTLEMENT_STATE);

  const effectiveStatus =
    payState.status === "paid" ? "PAID" : approveState.status === "approved" ? "APPROVED" : status;
  const error = approveState.error ?? payState.error;

  return (
    <div className="flex flex-col items-end gap-2">
      {error ? <FormMessage className="text-xs">{tErrors(error)}</FormMessage> : null}
      {effectiveStatus === "DRAFT" ? (
        <form action={approveAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={id} />
          <SubmitButton variant="outline">{t("approve")}</SubmitButton>
        </form>
      ) : effectiveStatus === "APPROVED" ? (
        <form action={payAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={id} />
          <SubmitButton>{t("markPaid")}</SubmitButton>
        </form>
      ) : null}
    </div>
  );
}
