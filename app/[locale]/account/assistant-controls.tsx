"use client";

import { useLocale, useTranslations } from "next-intl";

import { leaveAssistantAction } from "@/app/[locale]/account/assistant-actions";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useActionFeedback, useGuardedActionState } from "@/lib/ui/action-feedback";
import { IDLE_ASSISTANT_JOIN_STATE } from "@/lib/validation/assistants";

/** Account settings → "Assistant of <teacher>" → Leave (W7a): confirmed, audited `assistant.link.leave`. */
export function LeaveAssistantButton({ linkId, teacherName }: { linkId: string; teacherName: string }) {
  const t = useTranslations("Account.assistant");
  const tErrors = useTranslations("Assistants.errors");
  const tToasts = useTranslations("Toasts");
  const locale = useLocale();
  const [state, formAction] = useGuardedActionState(leaveAssistantAction, IDLE_ASSISTANT_JOIN_STATE);
  useActionFeedback(state, {
    success: (status) => (status === "left" ? tToasts("assistantLeft") : null),
    error: (key) => tErrors(key),
  });
  return (
    <ConfirmAction
      label={t("leave")}
      variant="outline"
      triggerClassName="w-full sm:w-auto"
      title={t("leaveTitle", { teacher: teacherName })}
      description={t("leaveDescription", { teacher: teacherName })}
      action={formAction}
      fields={{ locale, linkId }}
    />
  );
}
