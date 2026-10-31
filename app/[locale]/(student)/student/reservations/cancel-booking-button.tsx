"use client";

import { useLocale, useTranslations } from "next-intl";

import { cancelBookingAction } from "@/app/[locale]/(student)/student/reservations/booking-actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { IDLE_STUDENT_STATE } from "@/lib/validation/student";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * A student cancelling their own single-session booking (F6), pending or
 * confirmed, until the session starts. U8: behind a confirmation, and the same
 * button wherever the booking appears (My requests, the class page, the
 * schedule, the calendar's day list).
 */
export function CancelBookingButton({ centerId, bookingId }: { centerId: string; bookingId: string }) {
  const t = useTranslations("StudentActions.cancelBooking");
  const tErrors = useTranslations("StudentReservations.bookingErrors");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(cancelBookingAction, IDLE_STUDENT_STATE);
  useActionFeedback(state, {
    success: () => t("done"),
    error: (key) => tErrors(key),
  });

  if (state.status === "cancelled") return null;

  return (
    <ConfirmAction
      label={t("trigger")}
      variant="outline"
      triggerClassName="h-11"
      title={t("title")}
      description={t("description")}
      action={formAction}
      fields={{ locale, centerId, bookingId }}
    />
  );
}
