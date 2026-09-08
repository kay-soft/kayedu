"use client";

import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export type GradeOption = { value: string; label: string };

export type StudentValues = {
  gradeId?: string;
  /** Present only once assigned (edit context) — never sent on create. */
  studentCode?: string;
  parentFirstName?: string;
  parentLastName?: string;
  parentPhone?: string;
  parentAltPhone?: string;
};

/**
 * The center-owned half of a student record — grade and parent details
 * (docs/01-data-model.md §2, §6, `StudentProfile`). Parent info is entirely
 * optional (spec §4.1): a center may not have it yet, or the student may not
 * have a reachable guardian on file. The student code is **not** a field
 * here — it is system-assigned (`lib/db/students.ts`) and shown read-only.
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
  const tPeople = useTranslations("People.fields");
  const tErrors = useTranslations("People.errors");

  const error = (name: string) =>
    fieldErrors?.[name] ? tErrors(fieldErrors[name]) : undefined;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {values?.studentCode ? (
        <Field id={`${idPrefix}-studentCode`} label={t("studentCode")}>
          <Input
            id={`${idPrefix}-studentCode`}
            // Never submitted: the code is system-assigned and immutable
            // (lib/db/students.ts) — this is display only.
            name="studentCodeDisplay"
            dir="ltr"
            value={values.studentCode}
            disabled
            readOnly
          />
        </Field>
      ) : null}

      <Field
        id={`${idPrefix}-gradeId`}
        label={t("grade")}
        optional
        error={error("gradeId")}
      >
        <Select
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
        </Select>
      </Field>

      <Field
        id={`${idPrefix}-parentFirstName`}
        label={t("parentFirstName")}
        optional
        error={error("parentFirstName")}
      >
        <Input
          id={`${idPrefix}-parentFirstName`}
          name="parentFirstName"
          defaultValue={values?.parentFirstName ?? ""}
          maxLength={60}
          placeholder={tPeople("firstNamePlaceholder")}
        />
      </Field>

      <Field
        id={`${idPrefix}-parentLastName`}
        label={t("parentLastName")}
        optional
        error={error("parentLastName")}
      >
        <Input
          id={`${idPrefix}-parentLastName`}
          name="parentLastName"
          defaultValue={values?.parentLastName ?? ""}
          maxLength={60}
          placeholder={tPeople("lastNamePlaceholder")}
        />
      </Field>

      <Field
        id={`${idPrefix}-parentPhone`}
        label={t("parentPhone")}
        optional
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
          placeholder={tPeople("phonePlaceholder")}
          aria-invalid={fieldErrors?.parentPhone ? true : undefined}
        />
      </Field>

      <Field
        id={`${idPrefix}-parentAltPhone`}
        label={t("parentAltPhone")}
        optional
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
          placeholder={tPeople("phonePlaceholder")}
          aria-invalid={fieldErrors?.parentAltPhone ? true : undefined}
        />
      </Field>
    </div>
  );
}
