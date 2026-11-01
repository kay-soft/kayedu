"use client";

import { LogOut } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { leaveClassAction } from "@/app/[locale]/(student)/student/reservations/actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { IDLE_STUDENT_STATE } from "@/lib/validation/student";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * "Leave class" (U8) for the student's own ACTIVE enrolment — on the class
 * page, the schedule and the calendar's day list. Always behind the
 * confirmation that says what stays on record and that they can ask to join
 * again. The parent portal never renders this.
 */
export function LeaveClassButton({
  centerId,
  classGroupId,
  fullWidth,
}: {
  centerId: string;
  classGroupId: string;
  fullWidth?: boolean;
}) {
  const t = useTranslations("StudentActions.leave");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(leaveClassAction, IDLE_STUDENT_STATE);
  useActionFeedback(state, {
    success: () => t("done"),
    error: (key) => t(`errors.${key === "forbidden" ? "forbidden" : "notFound"}`),
  });

  if (state.status === "left") return null;

  return (
    <ConfirmAction
      label={t("trigger")}
      icon={<LogOut className="size-4 rtl:-scale-x-100" aria-hidden />}
      variant="outline"
      triggerClassName={fullWidth ? "h-11 w-full" : "h-11"}
      title={t("title")}
      description={t("description")}
      confirmLabel={t("confirm")}
      action={formAction}
      fields={{ locale, centerId, classGroupId }}
    />
  );
}
