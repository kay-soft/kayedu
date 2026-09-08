"use client";

import { useTranslations } from "next-intl";

import { Select } from "@/components/ui/select";
import type { SelectOption } from "@/components/center/class-fields";

/**
 * The classes dashboard's filters (spec §4.1 item 3 "filterable dashboard").
 * A plain GET form, like `TypeAheadSearch`'s own underlying form — filter
 * state lives in the URL, and changing a select re-submits immediately so
 * there is no separate "Apply" step.
 */
export function ClassFilters({
  teacherId,
  subjectId,
  gradeId,
  teachers,
  subjects,
  grades,
  allLabel,
}: {
  teacherId: string;
  subjectId: string;
  gradeId: string;
  teachers: SelectOption[];
  subjects: SelectOption[];
  grades: SelectOption[];
  allLabel: string;
}) {
  const t = useTranslations("Classes.filters");

  return (
    <form className="grid gap-3 sm:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="filter-teacherId" className="text-xs font-medium text-text-secondary">
          {t("teacher")}
        </label>
        <Select
          id="filter-teacherId"
          name="teacherId"
          defaultValue={teacherId}
          submitOnChange
        >
          <option value="">{allLabel}</option>
          {teachers.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="filter-subjectId" className="text-xs font-medium text-text-secondary">
          {t("subject")}
        </label>
        <Select
          id="filter-subjectId"
          name="subjectId"
          defaultValue={subjectId}
          submitOnChange
        >
          <option value="">{allLabel}</option>
          {subjects.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="filter-gradeId" className="text-xs font-medium text-text-secondary">
          {t("grade")}
        </label>
        <Select
          id="filter-gradeId"
          name="gradeId"
          defaultValue={gradeId}
          submitOnChange
        >
          <option value="">{allLabel}</option>
          {grades.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
    </form>
  );
}
