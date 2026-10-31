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

/** U7: `centerId` is the reservation's branch — the action re-resolves it, never trusts it. */
export function TeacherReservationActions({ id, centerId }: { id: string; centerId: string }) {
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
          fields={{ locale, id, centerId }}
        />
        <form action={approveAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="centerId" value={centerId} />
          <SubmitButton className="w-full">
            <Check className="size-4" />
            {t("approve")}
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
