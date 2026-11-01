"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Field } from "@/components/shared/field";
import { Select } from "@/components/ui/select";
import {
  gradesForSystem,
  subjectsForGrade,
  type CatalogPickerData,
} from "@/lib/catalog-picker";

export type CatalogPickerValues = {
  educationSystemId: string;
  gradeId: string;
  subjectId: string;
};

/**
 * The education system → grade → subject picker every catalog form shares
 * (U3, docs/04-design-system.md §5 "Catalog pickers"): class create/edit, the
 * one-time session, and both teacher class requests.
 *
 * - The system narrows the grades (no system = every grade). Changing it
 *   clears a grade that is not in it, and with it the subject.
 * - The subject is disabled until a grade is chosen and lists only the
 *   subjects linked to that grade and offered here; changing the grade clears
 *   a subject that is no longer valid. Picking a grade with no system chosen
 *   fills in the grade's system.
 * - `systemName` null = the system is a narrowing aid only and posts nothing
 *   (a one-time session and a teacher request store no system).
 *
 * The server re-checks the pair either way (`isPairOffered`, refused as
 * `subjectNotInGrade`). Renders three `Field`s as siblings — the caller owns
 * the grid.
 */
export function CatalogPickerFields({
  idPrefix,
  data,
  defaultValues,
  systemName = "educationSystemId",
  noneLabel,
  errors,
  onSystemChange,
}: {
  idPrefix: string;
  data: CatalogPickerData;
  defaultValues?: Partial<CatalogPickerValues>;
  systemName?: string | null;
  noneLabel: string;
  errors?: Partial<Record<keyof CatalogPickerValues, string | undefined>>;
  onSystemChange?: (educationSystemId: string) => void;
}) {
  const t = useTranslations("CatalogPicker");
  const [systemId, setSystemId] = useState(defaultValues?.educationSystemId ?? "");
  const [gradeId, setGradeId] = useState(defaultValues?.gradeId ?? "");
  const [subjectId, setSubjectId] = useState(defaultValues?.subjectId ?? "");

  const narrowed = gradesForSystem(data.grades, systemId);
  // A record whose grade sits outside its system (pre-U3 data) still shows it.
  const currentGrade = data.grades.find((grade) => grade.value === gradeId);
  const gradeOptions =
    currentGrade && !narrowed.includes(currentGrade) ? [...narrowed, currentGrade] : narrowed;
  const subjectOptions = subjectsForGrade(data.subjects, gradeId);
  const linked = (nextGradeId: string, nextSubjectId: string) =>
    subjectsForGrade(data.subjects, nextGradeId).some((subject) => subject.value === nextSubjectId);

  function changeSystem(next: string) {
    setSystemId(next);
    onSystemChange?.(next);
    const grade = data.grades.find((option) => option.value === gradeId);
    if (next && grade && grade.systemId !== next) {
      setGradeId("");
      setSubjectId("");
    }
  }

  function changeGrade(next: string) {
    setGradeId(next);
    if (subjectId && !linked(next, subjectId)) setSubjectId("");
    const grade = data.grades.find((option) => option.value === next);
    if (!systemId && grade?.systemId && data.systems.some((system) => system.value === grade.systemId)) {
      setSystemId(grade.systemId);
      onSystemChange?.(grade.systemId);
    }
  }

  // A legacy record with a subject and no grade keeps its subject posted.
  const subjectDisabled = gradeId === "" && subjectId === "";
  const subjectHint =
    gradeId === "" ? t("chooseGradeFirst") : subjectOptions.length === 0 ? t("noSubjectsForGrade") : undefined;

  return (
    <>
      <Field
        id={`${idPrefix}-educationSystemId`}
        label={t("educationSystem")}
        optional
        error={errors?.educationSystemId}
      >
        <Select
          id={`${idPrefix}-educationSystemId`}
          name={systemName ?? undefined}
          value={systemId}
          onValueChange={changeSystem}
        >
          <option value="">{systemName ? noneLabel : t("anySystem")}</option>
          {data.systems.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field id={`${idPrefix}-gradeId`} label={t("grade")} optional error={errors?.gradeId}>
        <Select id={`${idPrefix}-gradeId`} name="gradeId" value={gradeId} onValueChange={changeGrade}>
          <option value="">{noneLabel}</option>
          {gradeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id={`${idPrefix}-subjectId`}
        label={t("subject")}
        optional
        hint={subjectHint}
        error={errors?.subjectId}
      >
        <Select
          id={`${idPrefix}-subjectId`}
          name="subjectId"
          value={subjectId}
          onValueChange={setSubjectId}
          disabled={subjectDisabled}
        >
          <option value="">{noneLabel}</option>
          {subjectOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {subjectId && !subjectOptions.some((option) => option.value === subjectId)
            ? data.subjects
                .filter((option) => option.value === subjectId)
                .map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))
            : null}
        </Select>
      </Field>
    </>
  );
}
