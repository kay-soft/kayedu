"use client";

import { Check, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  approveReservationAction,
  declineReservationAction,
} from "@/app/[locale]/(center)/approvals/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { IDLE_APPROVALS_STATE } from "@/lib/validation/approvals";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

export function ReservationActions({ id }: { id: string }) {
  const t = useTranslations("Approvals");
  const tErrors = useTranslations("Approvals.errors");
  const locale = useLocale();

  const [approveState, approveAction] = useGuardedActionState(approveReservationAction, IDLE_APPROVALS_STATE);
  const [declineState, declineAction] = useGuardedActionState(declineReservationAction, IDLE_APPROVALS_STATE);

  if (approveState.status === "approved") {
    return <Badge variant="success">{t("reservations.approved")}</Badge>;
  }
  if (declineState.status === "declined") {
    return <Badge variant="danger">{t("reservations.declined")}</Badge>;
  }

  const error = approveState.error ?? declineState.error;
  // F6: "sessionFull" names the first full session's date.
  const errorDate = approveState.errorDate;

  return (
    <div className="flex flex-col items-stretch gap-2 lg:items-end">
      {error ? <FormMessage className="text-xs">{errorDate ? tErrors(error, { date: errorDate }) : tErrors(error)}</FormMessage> : null}
      <div className="grid grid-cols-2 gap-2 lg:w-64">
        {/* A decline is final — it asks first (docs/04 §14.6). */}
        <ConfirmAction
          label={t("decline")}
          icon={<X className="size-4" aria-hidden />}
          variant="outline"
          triggerClassName="w-full"
          title={t("declineConfirm.title")}
          description={t("declineConfirm.body")}
          action={declineAction}
          fields={{ locale, id }}
        />
        <form action={approveAction}>
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
