"use client";

import { useActionState } from "react";
import { BookOpen } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { createSessionRequestAction } from "@/app/[locale]/(teacher)/teacher/sessions/actions";
import { TimeRangeFields } from "@/components/center/time-range-fields";
import { FieldError, FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { IDLE_TEACHER_STATE } from "@/lib/validation/teacher";
import { EmptyState } from "@/components/shared/empty-state";

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
    return <EmptyState compact icon={<BookOpen />} title={t("noClasses")} description={t("noClassesHint")} />;
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
        <Select id="session-request-class" name="classGroupId" required>
          <option value="" disabled>
            {t("classPlaceholder")}
          </option>
          {classes.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="session-request-date" className="text-xs font-medium text-text-secondary">
            {t("date")}
          </label>
          <DatePicker id="session-request-date" name="date" required />
          {state.fieldErrors?.date ? (
            <FieldError>{tErrors(state.fieldErrors.date)}</FieldError>
          ) : null}
        </div>
        <TimeRangeFields
          idPrefix="session-request-time"
          startLabel={t("start")}
          endLabel={t("end")}
          error={
            state.fieldErrors?.startTime || state.fieldErrors?.endTime
              ? tErrors((state.fieldErrors.startTime ?? state.fieldErrors.endTime)!)
              : undefined
          }
          required
          className="sm:col-span-2"
        />
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
