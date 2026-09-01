"use client";

import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { Input } from "@/components/ui/input";
import { SelectInput } from "@/components/ui/select-input";

export type GradeOption = { value: string; label: string };

export type StudentValues = {
  gradeId?: string;
  studentCode?: string;
  parentFirstName?: string;
  parentLastName?: string;
  parentPhone?: string;
  parentAltPhone?: string;
};

/**
 * The center-owned half of a student record — grade, ID-card number and parent
 * details (docs/01-data-model.md §2, `StudentProfile`). These belong to *this*
 * center and stay editable even when the person's global identity does not.
 */
export function StudentFields({
  idPrefix,
  values,
  grades,
  fieldErrors,
  noneLabel,
}: {
  idPrefix: string;
  values?: StudentValues;
  grades: GradeOption[];
  fieldErrors?: Record<string, string>;
  noneLabel: string;
}) {
  const t = useTranslations("Students.fields");
  const tErrors = useTranslations("People.errors");

  const error = (name: string) =>
    fieldErrors?.[name] ? tErrors(fieldErrors[name]) : undefined;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        id={`${idPrefix}-gradeId`}
        label={t("grade")}
        error={error("gradeId")}
      >
        <SelectInput
          id={`${idPrefix}-gradeId`}
          name="gradeId"
          defaultValue={values?.gradeId ?? ""}
          aria-invalid={fieldErrors?.gradeId ? true : undefined}
        >
          <option value="">{noneLabel}</option>
          {grades.map((grade) => (
            <option key={grade.value} value={grade.value}>
              {grade.label}
            </option>
          ))}
        </SelectInput>
      </Field>

      <Field
        id={`${idPrefix}-studentCode`}
        label={t("studentCode")}
        hint={t("studentCodeHint")}
        error={error("studentCode")}
      >
        <Input
          id={`${idPrefix}-studentCode`}
          name="studentCode"
          // The card number is read and typed left-to-right in both locales.
          dir="ltr"
          defaultValue={values?.studentCode ?? ""}
          maxLength={24}
          aria-invalid={fieldErrors?.studentCode ? true : undefined}
        />
      </Field>

      <Field
        id={`${idPrefix}-parentFirstName`}
        label={t("parentFirstName")}
        error={error("parentFirstName")}
      >
        <Input
          id={`${idPrefix}-parentFirstName`}
          name="parentFirstName"
          defaultValue={values?.parentFirstName ?? ""}
          maxLength={60}
        />
      </Field>

      <Field
        id={`${idPrefix}-parentLastName`}
        label={t("parentLastName")}
        error={error("parentLastName")}
      >
        <Input
          id={`${idPrefix}-parentLastName`}
          name="parentLastName"
          defaultValue={values?.parentLastName ?? ""}
          maxLength={60}
        />
      </Field>

      <Field
        id={`${idPrefix}-parentPhone`}
        label={t("parentPhone")}
        error={error("parentPhone")}
      >
        <Input
          id={`${idPrefix}-parentPhone`}
          name="parentPhone"
          type="tel"
          inputMode="tel"
          dir="ltr"
          defaultValue={values?.parentPhone ?? ""}
          maxLength={20}
          aria-invalid={fieldErrors?.parentPhone ? true : undefined}
        />
      </Field>

      <Field
        id={`${idPrefix}-parentAltPhone`}
        label={t("parentAltPhone")}
        error={error("parentAltPhone")}
      >
        <Input
          id={`${idPrefix}-parentAltPhone`}
          name="parentAltPhone"
          type="tel"
          inputMode="tel"
          dir="ltr"
          defaultValue={values?.parentAltPhone ?? ""}
          maxLength={20}
          aria-invalid={fieldErrors?.parentAltPhone ? true : undefined}
        />
      </Field>
    </div>
  );
}
