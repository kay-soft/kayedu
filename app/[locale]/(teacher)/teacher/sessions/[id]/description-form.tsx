"use client";

import { useLocale, useTranslations } from "next-intl";

import { updateSessionDescriptionAction } from "@/app/[locale]/(teacher)/teacher/sessions/actions";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { IDLE_TEACHER_STATE } from "@/lib/validation/teacher";
import { useGuardedActionState } from "@/lib/ui/action-feedback";

/**
 * Session-description edit (spec §4.2 item 2). Editable up to the center's
 * `teacherEditDeadlineHours` setting (M10, closing the gap flagged at M7) —
 * unconditional when the center leaves that setting off.
 */
export function SessionDescriptionForm({
  sessionId,
  description,
}: {
  sessionId: string;
  description: string;
}) {
  const t = useTranslations("TeacherSessions.description");
  const tErrors = useTranslations("TeacherSessions.errors");
  const locale = useLocale();

  const [state, formAction] = useGuardedActionState(
    updateSessionDescriptionAction,
    IDLE_TEACHER_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="sessionId" value={sessionId} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="session-description" className="text-xs font-medium text-text-secondary">
          {t("label")}
        </label>
        <Textarea
          id="session-description"
          name="description"
          defaultValue={description}
          maxLength={500}
          placeholder={t("placeholder")}
          rows={3}
        />
      </div>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "saved" ? (
        <FormMessage tone="success">{t("saved")}</FormMessage>
      ) : null}

      <SubmitButton className="self-start">{t("save")}</SubmitButton>
    </form>
  );
}
