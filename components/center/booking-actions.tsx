"use client";

import { Check, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ConfirmAction } from "@/components/shared/confirm-action";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { IDLE_APPROVALS_STATE, type ApprovalsActionState } from "@/lib/validation/approvals";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

type DecisionAction = (state: ApprovalsActionState, formData: FormData) => Promise<ApprovalsActionState>;

/**
 * Accept / decline on one pending single-session booking (F6) — the branch's
 * `/approvals` and the teacher's own queue pass their own Server Actions, so
 * each keeps its own gate and pin; this only draws the same two buttons the
 * reservation cards use (docs/04 §11.3). A decline asks first (§14.6).
 */
export function BookingActions({
  id,
  approveAction,
  declineAction,
}: {
  id: string;
  approveAction: DecisionAction;
  declineAction: DecisionAction;
}) {
  const t = useTranslations("Approvals");
  const tErrors = useTranslations("Approvals.bookings.errors");
  const locale = useLocale();

  const [approveState, approve] = useGuardedActionState(approveAction, IDLE_APPROVALS_STATE);
  const [declineState, decline] = useGuardedActionState(declineAction, IDLE_APPROVALS_STATE);

  if (approveState.status === "approved") {
    return <Badge variant="success">{t("bookings.approved")}</Badge>;
  }
  if (declineState.status === "declined") {
    return <Badge variant="danger">{t("bookings.declined")}</Badge>;
  }

  const error = approveState.error ?? declineState.error;

  return (
    <div className="flex flex-col items-stretch gap-2 lg:items-end">
      {error ? <FormMessage className="text-xs">{tErrors(error)}</FormMessage> : null}
      <div className="grid grid-cols-2 gap-2 lg:w-64">
        <ConfirmAction
          label={t("decline")}
          icon={<X className="size-4" aria-hidden />}
          variant="outline"
          triggerClassName="w-full"
          title={t("bookings.declineConfirm.title")}
          description={t("bookings.declineConfirm.body")}
          action={decline}
          fields={{ locale, id }}
        />
        <form action={approve}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={id} />
          <SubmitButton className="w-full">
            <Check className="size-4" />
            {t("approve")}
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
