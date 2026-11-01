"use client";

import { useTranslations } from "next-intl";

import { FilterField } from "@/components/shared/filter-bar";
import { Select } from "@/components/ui/select";
import type { SelectOption } from "@/components/center/class-fields";
import { GradeSubjectFilterFields } from "@/components/shared/grade-subject-filter";
import { UrlFilterForm } from "@/components/shared/url-filters";
import type { CatalogOption, CatalogSubjectOption } from "@/lib/catalog-picker";

/**
 * The classes dashboard's filters (spec §4.1 item 3 "filterable dashboard").
 * A plain GET form (`UrlFilterForm`: a soft navigation with JavaScript, docs/02 §14), like `TypeAheadSearch`'s own underlying form — filter
 * state lives in the URL, and changing a select re-submits immediately so
 * there is no separate "Apply" step. Grade comes before subject and narrows it
 * (U3, `GradeSubjectFilterFields`).
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
  subjects: CatalogSubjectOption[];
  grades: CatalogOption[];
  allLabel: string;
}) {
  const t = useTranslations("Classes.filters");

  return (
    <UrlFilterForm className="grid gap-3 sm:grid-cols-3">
      <FilterField label={t("teacher")} htmlFor="filter-teacherId">
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
      </FilterField>

      <GradeSubjectFilterFields
        gradeId={gradeId}
        subjectId={subjectId}
        grades={grades}
        subjects={subjects}
        allLabel={allLabel}
        gradeLabel={t("grade")}
        subjectLabel={t("subject")}
      />
    </UrlFilterForm>
  );
}
