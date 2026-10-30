"use client";

import { useTranslations } from "next-intl";

import { FilterField } from "@/components/shared/filter-bar";
import { GradeSubjectFilterFields } from "@/components/shared/grade-subject-filter";
import { Select } from "@/components/ui/select";
import { UrlFilterForm } from "@/components/shared/url-filters";
import type { CatalogSubjectOption } from "@/lib/catalog-picker";

export type DiscoverFilterOption = { value: string; label: string };

/**
 * Grade/subject/day filter pills (docs/04-design-system.md §10). A plain GET
 * form — state lives in the URL, exactly like every other list filter in this
 * app (`TeacherSessionFilters`, `SessionFilters`). Subject/grade options carry
 * the global catalog id as of M13 (`CatalogSubject`/`CatalogGrade` — a single
 * id now means the same thing at every centre, docs/02-architecture.md §14),
 * with a locale-resolved label. Grade comes first and narrows the subjects to
 * the ones linked to it; with no grade every subject appears once (U3).
 */
export function DiscoverFilters({
  subject,
  grade,
  allGradesValue = "",
  day,
  subjects,
  grades,
  dayNames,
  allLabel,
}: {
  subject: string;
  grade: string;
  /**
   * What the grade filter's "All" posts. Empty — unless the student's account
   * grade pre-selects one (F4): an empty value drops the param, which would
   * read as "use my grade" again, so "All" is the explicit `all`.
   */
  allGradesValue?: string;
  day: string;
  subjects: CatalogSubjectOption[];
  grades: DiscoverFilterOption[];
  dayNames: string[];
  allLabel: string;
}) {
  const t = useTranslations("StudentDiscover.filters");

  return (
    <UrlFilterForm className="grid gap-3 sm:grid-cols-3">
      <GradeSubjectFilterFields
        gradeParam="grade"
        subjectParam="subject"
        gradeId={grade}
        subjectId={subject}
        grades={grades}
        subjects={subjects}
        allLabel={allLabel}
        allGradesValue={allGradesValue}
        gradeLabel={t("grade")}
        subjectLabel={t("subject")}
        selectClassName="rounded-full"
      />

      <FilterField label={t("day")} htmlFor="filter-day">
        <Select
          id="filter-day"
          name="day"
          defaultValue={day}
          className="rounded-full"
          submitOnChange
        >
          <option value="">{allLabel}</option>
          {dayNames.map((name, index) => (
            <option key={name} value={index}>
              {name}
            </option>
          ))}
        </Select>
      </FilterField>
    </UrlFilterForm>
  );
}
