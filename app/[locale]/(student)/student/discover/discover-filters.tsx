"use client";

import { useTranslations } from "next-intl";

import { Select } from "@/components/ui/select";

export type DiscoverFilterOption = { value: string; label: string };

/**
 * Grade/subject/day filter pills (docs/04-design-system.md §10). A plain GET
 * form — state lives in the URL, exactly like every other list filter in this
 * app (`TeacherSessionFilters`, `SessionFilters`). Subject/grade options carry
 * the global catalog id as of M13 (`CatalogSubject`/`CatalogGrade` — a single
 * id now means the same thing at every centre, docs/02-architecture.md §14),
 * with a locale-resolved label; the page derives them from what's actually
 * present in the combined result set.
 */
export function DiscoverFilters({
  subject,
  grade,
  day,
  subjects,
  grades,
  dayNames,
  allLabel,
}: {
  subject: string;
  grade: string;
  day: string;
  subjects: DiscoverFilterOption[];
  grades: DiscoverFilterOption[];
  dayNames: string[];
  allLabel: string;
}) {
  const t = useTranslations("StudentDiscover.filters");

  return (
    <form className="grid gap-3 sm:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="filter-subject" className="text-xs font-medium text-text-secondary">
          {t("subject")}
        </label>
        <Select
          id="filter-subject"
          name="subject"
          defaultValue={subject}
          className="rounded-full"
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
        <label htmlFor="filter-grade" className="text-xs font-medium text-text-secondary">
          {t("grade")}
        </label>
        <Select
          id="filter-grade"
          name="grade"
          defaultValue={grade}
          className="rounded-full"
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

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="filter-day" className="text-xs font-medium text-text-secondary">
          {t("day")}
        </label>
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
      </div>
    </form>
  );
}
