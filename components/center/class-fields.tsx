"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { ShareType } from "@prisma/client";

import { Field } from "@/components/shared/field";
import { ToggleRow } from "@/components/settings/toggle-row";
import { Input } from "@/components/ui/input";
import { SelectInput } from "@/components/ui/select-input";
import { formatMoney } from "@/lib/format";
import { MAX_LATE_THRESHOLD_MINUTES } from "@/lib/validation/classes";
import { splitShare } from "@/lib/money";

export type SelectOption = { value: string; label: string };

export type ClassFieldsValues = {
  teacherId: string;
  subjectId: string;
  gradeId: string;
  educationSystemId: string;
  roomId: string;
  price: string;
  centerShareType: ShareType;
  centerShareValue: string;
  capacity: string;
  attendanceRequired: boolean;
  lateThresholdMinutes: string;
  acceptsNewStudents: boolean;
  requiresConfirmation: boolean;
};

/**
 * Every field a `ClassGroup` carries (docs/01-data-model.md §2): who teaches
 * it, what/whom it's for, its room, its price and center-cut, capacity and
 * the attendance/enrollment flags. Shared between the create form (the "Add
 * class" dialog) and the edit form on the class detail page, exactly like
 * `student-fields.tsx` is shared between `StudentForm` and
 * `StudentProfileForm`.
 */
export function ClassFields({
  idPrefix,
  values,
  teachers,
  subjects,
  grades,
  educationSystems,
  rooms,
  noneLabel,
  fieldErrors,
}: {
  idPrefix: string;
  values: ClassFieldsValues;
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  educationSystems: SelectOption[];
  rooms: SelectOption[];
  noneLabel: string;
  fieldErrors?: Record<string, string>;
}) {
  const t = useTranslations("Classes.fields");
  const tErrors = useTranslations("Classes.errors");
  const locale = useLocale();

  const [shareType, setShareType] = useState<ShareType>(values.centerShareType);
  const [shareValue, setShareValue] = useState(values.centerShareValue);
  const [priceInput, setPriceInput] = useState(values.price);

  const error = (name: string) =>
    fieldErrors?.[name] ? tErrors(fieldErrors[name]) : undefined;

  const priceEgp = Number(priceInput);
  const sharePreviewable =
    Number.isFinite(priceEgp) &&
    priceEgp >= 0 &&
    shareValue.trim() !== "" &&
    Number.isFinite(Number(shareValue));
  const preview = sharePreviewable
    ? splitShare(
        Math.round(priceEgp * 100),
        shareType,
        shareType === "FIXED"
          ? Math.round(Number(shareValue) * 100)
          : Math.round(Number(shareValue)),
      )
    : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${idPrefix}-teacherId`}
          label={t("teacher")}
          error={error("teacherId")}
        >
          <SelectInput
            id={`${idPrefix}-teacherId`}
            name="teacherId"
            defaultValue={values.teacherId}
            required
            aria-invalid={fieldErrors?.teacherId ? true : undefined}
          >
            <option value="" disabled>
              {t("teacherPlaceholder")}
            </option>
            {teachers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field
          id={`${idPrefix}-subjectId`}
          label={t("subject")}
          optional
          error={error("subjectId")}
        >
          <SelectInput
            id={`${idPrefix}-subjectId`}
            name="subjectId"
            defaultValue={values.subjectId}
          >
            <option value="">{noneLabel}</option>
            {subjects.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field
          id={`${idPrefix}-gradeId`}
          label={t("grade")}
          optional
          error={error("gradeId")}
        >
          <SelectInput
            id={`${idPrefix}-gradeId`}
            name="gradeId"
            defaultValue={values.gradeId}
          >
            <option value="">{noneLabel}</option>
            {grades.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field
          id={`${idPrefix}-educationSystemId`}
          label={t("educationSystem")}
          optional
          error={error("educationSystemId")}
        >
          <SelectInput
            id={`${idPrefix}-educationSystemId`}
            name="educationSystemId"
            defaultValue={values.educationSystemId}
          >
            <option value="">{noneLabel}</option>
            {educationSystems.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field
          id={`${idPrefix}-roomId`}
          label={t("room")}
          optional
          error={error("roomId")}
        >
          <SelectInput
            id={`${idPrefix}-roomId`}
            name="roomId"
            defaultValue={values.roomId}
          >
            <option value="">{noneLabel}</option>
            {rooms.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field
          id={`${idPrefix}-capacity`}
          label={t("capacity")}
          hint={t("capacityHint")}
          error={error("capacity")}
        >
          <Input
            id={`${idPrefix}-capacity`}
            name="capacity"
            type="number"
            dir="ltr"
            inputMode="numeric"
            min={0}
            max={1000}
            step={1}
            defaultValue={values.capacity}
            aria-invalid={fieldErrors?.capacity ? true : undefined}
          />
        </Field>
      </div>

      <div className="rounded-xl border border-border p-3 sm:p-4">
        <p className="mb-3 text-sm font-medium text-text-primary">
          {t("moneyTitle")}
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field id={`${idPrefix}-price`} label={t("price")} error={error("price")}>
            <Input
              id={`${idPrefix}-price`}
              name="price"
              type="number"
              dir="ltr"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={priceInput}
              onChange={(event) => setPriceInput(event.target.value)}
              aria-invalid={fieldErrors?.price ? true : undefined}
            />
          </Field>

          <Field id={`${idPrefix}-centerShareType`} label={t("shareType")}>
            <SelectInput
              id={`${idPrefix}-centerShareType`}
              name="centerShareType"
              value={shareType}
              onChange={(event) => setShareType(event.target.value as ShareType)}
            >
              <option value="PERCENTAGE">{t("percentage")}</option>
              <option value="FIXED">{t("fixed")}</option>
            </SelectInput>
          </Field>

          <Field
            id={`${idPrefix}-shareValue`}
            label={shareType === "FIXED" ? t("shareValueEgp") : t("shareValuePct")}
            error={error("shareValue")}
          >
            <Input
              id={`${idPrefix}-shareValue`}
              name="shareValue"
              type="number"
              dir="ltr"
              inputMode="decimal"
              min={0}
              {...(shareType === "FIXED"
                ? { step: "0.01" }
                : { step: 1, max: 100 })}
              value={shareValue}
              onChange={(event) => setShareValue(event.target.value)}
              aria-invalid={fieldErrors?.shareValue ? true : undefined}
            />
          </Field>
        </div>

        {preview ? (
          <dl className="mt-3 flex flex-col gap-1 text-sm sm:flex-row sm:gap-6">
            <div className="flex justify-between gap-3 sm:block">
              <dt className="text-text-secondary">{t("centerShare")}</dt>
              <dd className="font-semibold tabular-nums">
                {formatMoney(preview.centerShare, locale)}
              </dd>
            </div>
            <div className="flex justify-between gap-3 sm:block">
              <dt className="text-text-secondary">{t("teacherShare")}</dt>
              <dd className="font-semibold tabular-nums">
                {formatMoney(preview.teacherShare, locale)}
              </dd>
            </div>
          </dl>
        ) : null}
        <p className="mt-2 text-xs text-text-muted">{t("snapshotNote")}</p>
      </div>

      <div className="flex flex-col gap-3">
        <ToggleRow
          name="attendanceRequired"
          label={t("attendanceRequired")}
          description={t("attendanceRequiredHint")}
          defaultChecked={values.attendanceRequired}
        />

        <div className="grid gap-4 sm:grid-cols-2 sm:items-end">
          <Field
            id={`${idPrefix}-lateThresholdMinutes`}
            label={t("lateThreshold")}
            hint={t("lateThresholdHint")}
            error={error("lateThresholdMinutes")}
          >
            <Input
              id={`${idPrefix}-lateThresholdMinutes`}
              name="lateThresholdMinutes"
              type="number"
              dir="ltr"
              inputMode="numeric"
              min={0}
              max={MAX_LATE_THRESHOLD_MINUTES}
              step={1}
              defaultValue={values.lateThresholdMinutes}
              aria-invalid={
                fieldErrors?.lateThresholdMinutes ? true : undefined
              }
            />
          </Field>
        </div>

        <ToggleRow
          name="acceptsNewStudents"
          label={t("acceptsNewStudents")}
          description={t("acceptsNewStudentsHint")}
          defaultChecked={values.acceptsNewStudents}
        />

        <ToggleRow
          name="requiresConfirmation"
          label={t("requiresConfirmation")}
          description={t("requiresConfirmationHint")}
          defaultChecked={values.requiresConfirmation}
        />
      </div>
    </div>
  );
}
