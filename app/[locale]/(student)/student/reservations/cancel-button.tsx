"use client";

import { useLocale, useTranslations } from "next-intl";

import { cancelReservationAction } from "@/app/[locale]/(student)/student/reservations/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { IDLE_STUDENT_STATE } from "@/lib/validation/student";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * A student withdrawing their own PENDING enrolment request (spec §4.3). U8:
 * behind a confirmation, and the same button wherever the request appears
 * (My requests, the class page).
 */
export function CancelReservationButton({
  centerId,
  reservationId,
  fullWidth,
}: {
  centerId: string;
  reservationId: string;
  fullWidth?: boolean;
}) {
  const t = useTranslations("StudentActions.cancelRequest");
  const tErrors = useTranslations("StudentReservations.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(cancelReservationAction, IDLE_STUDENT_STATE);
  useActionFeedback(state, {
    success: () => t("done"),
    error: (key) => tErrors(key),
  });

  if (state.status === "cancelled") return null;

  return (
    <ConfirmAction
      label={t("trigger")}
      variant="outline"
      triggerClassName={fullWidth ? "h-11 w-full" : "h-11"}
      title={t("title")}
      description={t("description")}
      action={formAction}
      fields={{ locale, centerId, reservationId }}
    />
  );
}
