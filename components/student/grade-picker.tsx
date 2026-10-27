"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { Select } from "@/components/ui/select";
import type { GradePickerData } from "@/lib/student-grade-options";

/**
 * Education system → grade (F4, docs/04 §11.23): one control for the account
 * grade, shared by onboarding's "Your studies" and Account → Study details.
 * The system select only narrows the grade list (it posts nothing); the
 * grade select posts `gradeId`. Native-feeling, 44px rows, from the product's
 * one `Select`. `optional` adds an empty choice so the grade can be cleared.
 */
export function GradePicker({
  data,
  defaultGradeId,
  optional,
  error,
  idPrefix = "grade",
}: {
  data: GradePickerData;
  defaultGradeId: string;
  optional?: boolean;
  /** Already-translated message for the grade field. */
  error?: string;
  idPrefix?: string;
}) {
  const t = useTranslations("Account.study.picker");
  const [systemId, setSystemId] = useState(data.currentSystemId);
  const [gradeId, setGradeId] = useState(defaultGradeId);

  const gradeOptions = data.grades.filter((grade) => grade.systemId === systemId);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id={`${idPrefix}-system`} label={t("system")}>
        <Select
          id={`${idPrefix}-system`}
          value={systemId}
          onValueChange={(next) => {
            setSystemId(next);
            // A grade from another system is no longer a valid choice.
            if (!data.grades.some((grade) => grade.value === gradeId && grade.systemId === next)) {
              setGradeId("");
            }
          }}
          placeholder={t("systemPlaceholder")}
        >
          {data.systems.map((system) => (
            <option key={system.value} value={system.value}>
              {system.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field id={`${idPrefix}-grade`} label={t("grade")} optional={optional} error={error}>
        <Select
          id={`${idPrefix}-grade`}
          name="gradeId"
          value={gradeId}
          onValueChange={setGradeId}
          disabled={systemId === ""}
          placeholder={t("gradePlaceholder")}
          required={!optional}
          aria-invalid={error ? true : undefined}
        >
          {optional ? <option value="">{t("none")}</option> : null}
          {gradeOptions.map((grade) => (
            <option key={grade.value} value={grade.value}>
              {grade.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
