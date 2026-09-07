"use client";

import { useActionState } from "react";
import { Check, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  approveOwnReservationAction,
  declineOwnReservationAction,
} from "@/app/[locale]/(teacher)/teacher/approvals/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Badge } from "@/components/ui/badge";
import { IDLE_APPROVALS_STATE } from "@/lib/validation/approvals";

export function TeacherReservationActions({ id }: { id: string }) {
  const t = useTranslations("TeacherApprovals");
  const tErrors = useTranslations("TeacherApprovals.errors");
  const locale = useLocale();

  const [approveState, approveAction] = useActionState(
    approveOwnReservationAction,
    IDLE_APPROVALS_STATE,
  );
  const [declineState, declineAction] = useActionState(
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
    <div className="flex flex-col items-end gap-2">
      {error ? <FormMessage className="text-xs">{tErrors(error)}</FormMessage> : null}
      <div className="flex gap-2">
        <form action={declineAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={id} />
          <SubmitButton variant="outline">
            <X className="size-4" />
            {t("decline")}
          </SubmitButton>
        </form>
        <form action={approveAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="id" value={id} />
          <SubmitButton>
            <Check className="size-4" />
            {t("approve")}
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
