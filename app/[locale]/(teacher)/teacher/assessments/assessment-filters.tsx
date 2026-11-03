"use client";

import { useTranslations } from "next-intl";

import { FilterField } from "@/components/shared/filter-bar";
import { UrlFilterForm } from "@/components/shared/url-filters";
import { Select } from "@/components/ui/select";

/**
 * Filters for the teacher's exams and homework (W2): type, class, and — under
 * All branches with two or more — branch. State lives in the URL (a soft GET
 * through `UrlFilterForm`, docs/02 §14); the page re-checks the branch against
 * the branches in view, so the filter can only narrow.
 */
export function AssessmentFilters({
  type,
  classGroupId,
  classes,
  branches,
  branch,
}: {
  type: string;
  classGroupId: string;
  classes: { value: string; label: string }[];
  branches: { id: string; name: string }[];
  branch: string;
}) {
  const t = useTranslations("TeacherAssessments.filters");
  const tType = useTranslations("TeacherAssessments.type");
  const tScope = useTranslations("TeacherScope");

  return (
    <UrlFilterForm className={branches.length > 1 ? "grid gap-3 sm:grid-cols-3" : "grid gap-3 sm:grid-cols-2"}>
      <FilterField label={t("type")} htmlFor="filter-type">
        <Select
          id="filter-type"
          name="type"
          defaultValue={type}
          submitOnChange
          options={[
            { value: "", label: t("allTypes") },
            { value: "EXAM", label: tType("EXAM") },
            { value: "HOMEWORK", label: tType("HOMEWORK") },
          ]}
        />
      </FilterField>
      <FilterField label={t("class")} htmlFor="filter-class">
        <Select
          id="filter-class"
          name="class"
          defaultValue={classGroupId}
          submitOnChange
          options={[{ value: "", label: t("allClasses") }, ...classes]}
        />
      </FilterField>
      {branches.length > 1 ? (
        <FilterField label={tScope("branch")} htmlFor="filter-branch">
          <Select
            id="filter-branch"
            name="branch"
            defaultValue={branch}
            submitOnChange
            options={[
              { value: "", label: tScope("allBranches") },
              ...branches.map((item) => ({ value: item.id, label: item.name })),
            ]}
          />
        </FilterField>
      ) : null}
    </UrlFilterForm>
  );
}
