"use client";

import { Check, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  approveOwnReservationAction,
  declineOwnReservationAction,
} from "@/app/[locale]/(teacher)/teacher/approvals/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { IDLE_APPROVALS_STATE } from "@/lib/validation/approvals";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

export function TeacherReservationActions({ id }: { id: string }) {
  const t = useTranslations("TeacherApprovals");
  const tErrors = useTranslations("TeacherApprovals.errors");
  const locale = useLocale();

  const [approveState, approveAction] = useGuardedActionState(
    approveOwnReservationAction,
    IDLE_APPROVALS_STATE,
  );
  const [declineState, declineAction] = useGuardedActionState(
    declineOwnReservationAction,
    IDLE_APPROVALS_STATE,
  );

  if (approveState.status === "approved") {
    return <Badge variant="success">{t("approved")}</Badge>;
  }
  if (declineState.status === "declined") {
    return <Badge variant="danger">{t("declined")}</Badge>;
  }

  const error = approveState.error ?? declineState.error;

  return (
    <div className="flex flex-col items-stretch gap-2 lg:items-end">
      {error ? <FormMessage className="text-xs">{tErrors(error)}</FormMessage> : null}
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
