"use client";

import { useActionState, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { requestToTeachAction } from "@/app/[locale]/(teacher)/teacher/centers/actions";
import { Field } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { SubmitButton } from "@/components/shared/submit-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SelectInput } from "@/components/ui/select-input";
import { Textarea } from "@/components/ui/textarea";
import { IDLE_TEACHER_STATE } from "@/lib/validation/teacher";

type SelectOption = { value: string; label: string };
type CenterCard = { id: string; name: string; logoUrl: string | null; themeColor: string };

const DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;

export function TeachAtCenterCard({
  center,
  subjects,
  grades,
}: {
  center: CenterCard;
  subjects: SelectOption[];
  grades: SelectOption[];
}) {
  const t = useTranslations("TeacherCenters");
  const tDays = useTranslations("Classes");
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-3">
        <span
          aria-hidden
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-base font-bold text-white"
          style={{ backgroundColor: center.themeColor }}
        >
          {center.name.trim().charAt(0)}
        </span>
        <CardTitle className="truncate text-base">{center.name}</CardTitle>
      </CardHeader>
      <CardContent>
        {open ? (
          <RequestForm
            centerId={center.id}
            centerName={center.name}
            subjects={subjects}
            grades={grades}
            dayNames={tDays.raw("dayNames") as string[]}
            onCancel={() => setOpen(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-dashed border-border px-4 text-sm font-medium text-text-secondary hover:bg-surface-subtle"
          >
            {t("requestButton")}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function RequestForm({
  centerId,
  centerName,
  subjects,
  grades,
  dayNames,
  onCancel,
}: {
  centerId: string;
  centerName: string;
  subjects: SelectOption[];
  grades: SelectOption[];
  dayNames: string[];
  onCancel: () => void;
}) {
  const t = useTranslations("TeacherCenters.request");
  const tErrors = useTranslations("TeacherCenters.errors");
  const locale = useLocale();
  const [state, formAction] = useActionState(requestToTeachAction, IDLE_TEACHER_STATE);

  if (state.status === "created") {
    return <FormMessage tone="success">{t("submitted")}</FormMessage>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="centerId" value={centerId} />

      <p className="text-sm font-medium text-text-primary">{t("title", { center: centerName })}</p>
      <p className="text-xs text-text-muted">{t("description")}</p>

      {state.error ? <FormMessage>{tErrors(state.error)}</FormMessage> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${centerId}-subjectId`}
          label={t("subject")}
          optional
          error={state.fieldErrors?.subjectId ? tErrors(state.fieldErrors.subjectId) : undefined}
        >
          <SelectInput id={`${centerId}-subjectId`} name="subjectId" defaultValue="">
            <option value="">{t("none")}</option>
            {subjects.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field
          id={`${centerId}-gradeId`}
          label={t("grade")}
          optional
          error={state.fieldErrors?.gradeId ? tErrors(state.fieldErrors.gradeId) : undefined}
        >
          <SelectInput id={`${centerId}-gradeId`} name="gradeId" defaultValue="">
            <option value="">{t("none")}</option>
            {grades.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id={`${centerId}-dayOfWeek`}
          label={t("day")}
          error={state.fieldErrors?.dayOfWeek ? tErrors(state.fieldErrors.dayOfWeek) : undefined}
        >
          <SelectInput id={`${centerId}-dayOfWeek`} name="dayOfWeek" defaultValue="0">
            {DAY_INDEXES.map((day) => (
              <option key={day} value={day}>
                {dayNames[day]}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field
          id={`${centerId}-startTime`}
          label={t("start")}
          error={state.fieldErrors?.startTime ? tErrors(state.fieldErrors.startTime) : undefined}
        >
          <Input id={`${centerId}-startTime`} name="startTime" type="time" defaultValue="16:00" />
        </Field>

        <Field
          id={`${centerId}-endTime`}
          label={t("end")}
          error={state.fieldErrors?.endTime ? tErrors(state.fieldErrors.endTime) : undefined}
        >
          <Input id={`${centerId}-endTime`} name="endTime" type="time" defaultValue="18:00" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${centerId}-capacity`}
          label={t("capacity")}
          hint={t("capacityHint")}
          error={state.fieldErrors?.capacity ? tErrors(state.fieldErrors.capacity) : undefined}
        >
          <Input id={`${centerId}-capacity`} name="capacity" type="number" min={0} defaultValue={0} />
        </Field>

        <Field
          id={`${centerId}-lateThresholdMinutes`}
          label={t("lateThreshold")}
          error={
            state.fieldErrors?.lateThresholdMinutes
              ? tErrors(state.fieldErrors.lateThresholdMinutes)
              : undefined
          }
        >
          <Input
            id={`${centerId}-lateThresholdMinutes`}
            name="lateThresholdMinutes"
            type="number"
            min={0}
            defaultValue={10}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input type="checkbox" name="attendanceRequired" defaultChecked className="size-4 rounded border-border" />
        {t("attendanceRequired")}
      </label>

      <Field id={`${centerId}-note`} label={t("note")} optional>
        <Textarea id={`${centerId}-note`} name="note" maxLength={300} rows={2} placeholder={t("notePlaceholder")} />
      </Field>

      <div className="flex gap-2">
        <SubmitButton className="self-start">{t("submit")}</SubmitButton>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm text-text-secondary hover:bg-surface-subtle"
        >
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
