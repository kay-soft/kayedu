"use client";

import { useState } from "react";

import { FilterField } from "@/components/shared/filter-bar";
import { Select } from "@/components/ui/select";
import { filterSubjectsForGrade, type CatalogOption, type CatalogSubjectOption } from "@/lib/catalog-picker";
import { useUrlFilterSync } from "@/lib/ui/url-filter-sync";

/**
 * The grade → subject pair of a GET filter bar (U3, docs/04-design-system.md
 * §5 "Catalog pickers"): grade first; with a grade chosen the subjects narrow
 * to the ones linked to it, with none every subject appears once. Changing the
 * grade clears a subject that no longer fits **before** the form re-submits,
 * so the URL never carries a pair that cannot match.
 *
 * Both selects are controlled and re-seed from the server's values whenever
 * the URL moves without them (Back, a reset link) — the same contract
 * `Select` keeps for itself (`lib/ui/url-filter-sync.ts`). Renders the two
 * `FilterField`s as siblings; the caller owns the grid.
 */
export function GradeSubjectFilterFields({
  idPrefix = "filter",
  gradeParam = "gradeId",
  subjectParam = "subjectId",
  gradeId,
  subjectId,
  grades,
  subjects,
  allLabel,
  allGradesValue = "",
  gradeLabel,
  subjectLabel,
  selectClassName,
}: {
  idPrefix?: string;
  /** The query-string names (Discover and Explore use `grade` / `subject`). */
  gradeParam?: string;
  subjectParam?: string;
  gradeId: string;
  subjectId: string;
  grades: CatalogOption[];
  subjects: CatalogSubjectOption[];
  allLabel: string;
  /** What the grade's "All" posts (Discover's explicit `all`, F4); empty elsewhere. */
  allGradesValue?: string;
  gradeLabel: string;
  subjectLabel: string;
  /** Discover's pill shape (`rounded-full`); the default control elsewhere. */
  selectClassName?: string;
}) {
  const [grade, setGrade] = useState(gradeId);
  const [subject, setSubject] = useState(subjectId);
  const urlSync = useUrlFilterSync();
  const [seenUrlSync, setSeenUrlSync] = useState(urlSync);
  if (urlSync !== seenUrlSync) {
    setSeenUrlSync(urlSync);
    setGrade(gradeId);
    setSubject(subjectId);
  }

  const narrowing = (value: string) => (value === allGradesValue ? "" : value);
  const subjectOptions = filterSubjectsForGrade(subjects, narrowing(grade));

  function changeGrade(next: string) {
    setGrade(next);
    if (subject && !filterSubjectsForGrade(subjects, narrowing(next)).some((option) => option.value === subject)) {
      setSubject("");
    }
  }

  return (
    <>
      <FilterField label={gradeLabel} htmlFor={`${idPrefix}-${gradeParam}`}>
        <Select
          id={`${idPrefix}-${gradeParam}`}
          name={gradeParam}
          value={grade}
          onValueChange={changeGrade}
          className={selectClassName}
          submitOnChange
        >
          <option value={allGradesValue}>{allLabel}</option>
          {grades.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </FilterField>

      <FilterField label={subjectLabel} htmlFor={`${idPrefix}-${subjectParam}`}>
        <Select
          id={`${idPrefix}-${subjectParam}`}
          name={subjectParam}
          value={subject}
          onValueChange={setSubject}
          className={selectClassName}
          submitOnChange
        >
          <option value="">{allLabel}</option>
          {subjectOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </FilterField>
    </>
  );
}
