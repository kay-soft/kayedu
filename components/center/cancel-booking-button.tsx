"use client";

import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ConfirmAction } from "@/components/shared/confirm-action";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import { IDLE_APPROVALS_STATE, type ApprovalsActionState } from "@/lib/validation/approvals";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

type CancelAction = (state: ApprovalsActionState, formData: FormData) => Promise<ApprovalsActionState>;

/**
 * "Cancel booking" on one confirmed, not-yet-arrived single-session booking
 * (T7, docs/04 §11.25). The branch's session page and the teacher's own
 * session page pass their own Server Action, so each keeps its own gate and
 * pin; this only draws the button. It asks first (§14.6): the seat is freed at
 * once and the student sees "Cancelled by the branch".
 */
export function CancelBookingButton({ id, action }: { id: string; action: CancelAction }) {
  const t = useTranslations("Sessions.booked.cancel");
  const locale = useLocale();
  const [state, cancel] = useGuardedActionState(action, IDLE_APPROVALS_STATE);

  if (state.status === "cancelled") return <Badge variant="neutral">{t("done")}</Badge>;

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      {state.error ? (
        <FormMessage className="text-xs">
          {t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.failed")}
        </FormMessage>
      ) : null}
      <ConfirmAction
        label={t("label")}
        icon={<X className="size-4" aria-hidden />}
        variant="outline"
        triggerClassName="h-11 w-full sm:w-auto"
        title={t("title")}
        description={t("body")}
        action={cancel}
        fields={{ locale, id }}
      />
    </div>
  );
}
