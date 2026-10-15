"use client";

import { useLocale, useTranslations } from "next-intl";
import type { SettlementStatus } from "@prisma/client";
import { Info } from "lucide-react";

import {
  approveSettlementAction,
  cancelSettlementAction,
  paySettlementAction,
} from "@/app/[locale]/(center)/settlements/actions";
import { FormMessage } from "@/components/shared/form-message";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { IDLE_SETTLEMENT_STATE } from "@/lib/validation/settlements";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

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

  const [approveState, approveAction] = useGuardedActionState(
    approveSettlementAction,
    IDLE_SETTLEMENT_STATE,
  );
  const [payState, payAction] = useGuardedActionState(paySettlementAction, IDLE_SETTLEMENT_STATE);
  const [cancelState, cancelAction] = useGuardedActionState(cancelSettlementAction, IDLE_SETTLEMENT_STATE);

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
        <p className="flex items-start gap-1.5 text-xs text-text-secondary">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("ownSettlementHint")}
        </p>
      ) : null}
      {/* Every transition is final — Paid has no partly-paid or unpaid state,
          and cancelling releases the claimed payments — so each asks first
          (docs/04 §14.6). The actions and their rules are unchanged. */}
      <div className="flex flex-wrap gap-2 sm:justify-end">
        {effectiveStatus === "DRAFT" ? (
          <>
            <ConfirmAction
              label={t("cancelDraft")}
              title={t("confirm.cancelTitle")}
              description={t("confirm.cancelBody")}
              action={cancelAction}
              fields={{ locale, id }}
            />
            {ownBlocked ? null : (
              <ConfirmAction
                label={t("approve")}
                variant="outline"
                tone="default"
                title={t("confirm.approveTitle")}
                description={t("confirm.approveBody")}
                action={approveAction}
                fields={{ locale, id }}
              />
            )}
          </>
        ) : effectiveStatus === "APPROVED" && !ownBlocked ? (
          <ConfirmAction
            label={t("markPaid")}
            variant="default"
            tone="default"
            title={t("confirm.payTitle")}
            description={t("confirm.payBody")}
            action={payAction}
            fields={{ locale, id }}
          />
        ) : null}
      </div>
    </div>
  );
}
