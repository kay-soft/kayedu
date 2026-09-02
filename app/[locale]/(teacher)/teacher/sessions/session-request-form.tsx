"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { createSessionRequestAction } from "@/app/[locale]/(teacher)/teacher/sessions/actions";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { SelectInput } from "@/components/ui/select-input";
import { Textarea } from "@/components/ui/textarea";
import { IDLE_TEACHER_STATE } from "@/lib/validation/teacher";

export type TeacherClassOption = { value: string; label: string };

/**
 * "Request new session" (spec §4.2 item 2, M10): a one-off session on one of
 * the teacher's own classes at this center — free room/time is a center
 * manager's call at `/approvals`, same shape as the class-request form.
 */
export function SessionRequestForm({ classes }: { classes: TeacherClassOption[] }) {
  const t = useTranslations("TeacherSessions.request");
  const tErrors = useTranslations("TeacherSessions.errors");
  const locale = useLocale();

  const [state, formAction] = useActionState(
    createSessionRequestAction,
    IDLE_TEACHER_STATE,
  );

  if (classes.length === 0) {
    return <p className="text-sm text-text-muted">{t("noClasses")}</p>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "created" ? (
        <FormMessage tone="success">{t("submitted")}</FormMessage>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="session-request-class" className="text-xs font-medium text-text-secondary">
          {t("class")}
        </label>
        <SelectInput id="session-request-class" name="classGroupId" required>
          <option value="" disabled>
            {t("classPlaceholder")}
          </option>
          {classes.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectInput>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="session-request-date" className="text-xs font-medium text-text-secondary">
            {t("date")}
          </label>
          <input
            id="session-request-date"
            type="date"
            name="date"
            required
            className="h-11 rounded-lg border border-border bg-background px-3 text-sm"
          />
          {state.fieldErrors?.date ? (
            <FieldError>{tErrors(state.fieldErrors.date)}</FieldError>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="session-request-start" className="text-xs font-medium text-text-secondary">
            {t("start")}
          </label>
          <input
            id="session-request-start"
            type="time"
            name="startTime"
            required
            className="h-11 rounded-lg border border-border bg-background px-3 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="session-request-end" className="text-xs font-medium text-text-secondary">
            {t("end")}
          </label>
          <input
            id="session-request-end"
            type="time"
            name="endTime"
            required
            className="h-11 rounded-lg border border-border bg-background px-3 text-sm"
          />
          {state.fieldErrors?.endTime ? (
            <FieldError>{tErrors(state.fieldErrors.endTime)}</FieldError>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="session-request-note" className="text-xs font-medium text-text-secondary">
          {t("note")}
        </label>
        <Textarea
          id="session-request-note"
          name="note"
          maxLength={300}
          placeholder={t("notePlaceholder")}
          rows={2}
        />
      </div>

      <SubmitButton className="self-start">{t("submit")}</SubmitButton>
    </form>
  );
}
