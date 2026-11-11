"use client";

import { useTranslations } from "next-intl";

import { markAllNotificationsReadAction } from "@/app/[locale]/notifications/actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_NOTIFICATION_STATE } from "@/lib/validation/notifications";

/** The inbox's "Mark all as read" (W1) — answers with a toast either way (docs/04 §14.2). */
export function MarkAllReadForm({ locale }: { locale: string }) {
  const t = useTranslations("Notifications");
  const [state, formAction] = useGuardedActionState(markAllNotificationsReadAction, IDLE_NOTIFICATION_STATE);
  useActionFeedback(state, { success: t("markedAllRead"), error: () => t("markAllFailed") });

  return (
    <form action={formAction} className="w-full sm:w-auto">
      <input type="hidden" name="locale" value={locale} />
      <SubmitButton variant="outline" className="w-full sm:w-auto">
        {t("markAllRead")}
      </SubmitButton>
    </form>
  );
}
