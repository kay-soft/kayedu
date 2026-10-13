"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { createClassRequestAction } from "@/app/[locale]/(teacher)/teacher/classes/actions";
import { TimeRangeFields } from "@/components/center/time-range-fields";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { IDLE_TEACHER_STATE } from "@/lib/validation/teacher";

export type SelectOption = { value: string; label: string };

const DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;

export function ClassRequestForm({
  subjects,
  grades,
}: {
  subjects: SelectOption[];
  grades: SelectOption[];
}) {
  const t = useTranslations("TeacherClasses.request");
  const tClasses = useTranslations("Classes");
  const tErrors = useTranslations("TeacherClasses.errors");
  const locale = useLocale();
  const dayNames = tClasses.raw("dayNames") as string[];

  const [state, formAction] = useActionState(createClassRequestAction, IDLE_TEACHER_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}
      {state.status === "created" ? (
        <FormMessage tone="success">{t("submitted")}</FormMessage>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="request-subjectId" label={t("subject")} optional error={state.fieldErrors?.subjectId ? tErrors(state.fieldErrors.subjectId) : undefined}>
          <Select id="request-subjectId" name="subjectId" defaultValue="">
            <option value="">{t("none")}</option>
            {subjects.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field id="request-gradeId" label={t("grade")} optional error={state.fieldErrors?.gradeId ? tErrors(state.fieldErrors.gradeId) : undefined}>
          <Select id="request-gradeId" name="gradeId" defaultValue="">
            <option value="">{t("none")}</option>
            {grades.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="request-dayOfWeek" label={t("day")} error={state.fieldErrors?.dayOfWeek ? tErrors(state.fieldErrors.dayOfWeek) : undefined}>
          <Select id="request-dayOfWeek" name="dayOfWeek" defaultValue="0">
            {DAY_INDEXES.map((day) => (
              <option key={day} value={day}>
                {dayNames[day]}
              </option>
            ))}
          </Select>
        </Field>

        <TimeRangeFields
          idPrefix="request-time"
          startLabel={t("start")}
          endLabel={t("end")}
          defaultStart="16:00"
          defaultEnd="18:00"
          error={
            state.fieldErrors?.startTime || state.fieldErrors?.endTime
              ? tErrors((state.fieldErrors.startTime ?? state.fieldErrors.endTime)!)
              : undefined
          }
          required
          className="sm:col-span-2"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="request-lateThresholdMinutes" label={t("lateThreshold")} error={state.fieldErrors?.lateThresholdMinutes ? tErrors(state.fieldErrors.lateThresholdMinutes) : undefined}>
          <Input id="request-lateThresholdMinutes" name="lateThresholdMinutes" type="number" min={0} defaultValue={10} />
        </Field>
      </div>

      <Field id="request-note" label={t("note")} optional>
        <Textarea id="request-note" name="note" maxLength={300} rows={2} placeholder={t("notePlaceholder")} />
      </Field>

      <SubmitButton className="self-start">{t("submit")}</SubmitButton>
    </form>
  );
}
