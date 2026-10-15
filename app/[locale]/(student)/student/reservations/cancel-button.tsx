"use client";

import { useLocale, useTranslations } from "next-intl";

import { cancelReservationAction } from "@/app/[locale]/(student)/student/reservations/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { IDLE_STUDENT_STATE } from "@/lib/validation/student";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

export function CancelReservationButton({
  centerId,
  reservationId,
}: {
  centerId: string;
  reservationId: string;
}) {
  const t = useTranslations("StudentReservations");
  const tErrors = useTranslations("StudentReservations.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(cancelReservationAction, IDLE_STUDENT_STATE);

  if (state.status === "cancelled") return null;

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="centerId" value={centerId} />
      <input type="hidden" name="reservationId" value={reservationId} />
      {state.error ? <FormMessage className="text-xs">{tErrors(state.error)}</FormMessage> : null}
      <SubmitButton variant="outline">{t("cancel")}</SubmitButton>
    </form>
  );
}
