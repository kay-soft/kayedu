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
 *
 * W9 (D-W42 item 7): with any PERSONAL workspace, the branch filter becomes a
 * **Source** filter — All, each branch, each workspace (tagged Private) — still
 * the `branch` URL key, still re-checked by the page against the teacher's own
 * branches and workspaces.
 */
export function AssessmentFilters({
  type,
  classGroupId,
  classes,
  branches,
  branch,
  workspaces = [],
}: {
  type: string;
  classGroupId: string;
  classes: { value: string; label: string }[];
  branches: { id: string; name: string }[];
  branch: string;
  /** W9: the teacher's own workspaces; with any, the filter is the Source filter. */
  workspaces?: { id: string; name: string }[];
}) {
  const t = useTranslations("TeacherAssessments.filters");
  const tType = useTranslations("TeacherAssessments.type");
  const tScope = useTranslations("TeacherScope");
  const tAssessments = useTranslations("TeacherAssessments");
  const withSource = workspaces.length > 0 && branches.length + workspaces.length > 1;
  const withFilter = branches.length > 1 || withSource;

  return (
    <UrlFilterForm className={withFilter ? "grid gap-3 sm:grid-cols-3" : "grid gap-3 sm:grid-cols-2"}>
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
      {withFilter ? (
        <FilterField label={withSource ? t("source") : tScope("branch")} htmlFor="filter-branch">
          <Select
            id="filter-branch"
            name="branch"
            defaultValue={branch}
            submitOnChange
            options={[
              { value: "", label: withSource ? t("allSources") : tScope("allBranches") },
              ...branches.map((item) => ({ value: item.id, label: item.name })),
              ...workspaces.map((item) => ({ value: item.id, label: `${item.name} · ${tAssessments("privateTag")}` })),
            ]}
          />
        </FilterField>
      ) : null}
    </UrlFilterForm>
  );
}
