"use client";

import { useTranslations } from "next-intl";

import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { UrlFilterForm } from "@/components/shared/url-filters";

export type BranchFilterOption = { id: string; name: string };

/**
 * The teacher portal's Branch filter (U7, docs/04 §11.29). Shown only under
 * All branches with more than one branch; `?branch=` narrows a list to one
 * branch, and the page re-checks it against the branches in view
 * (`branchesInView`) — the filter can never reach a branch the teacher does
 * not hold. A soft GET form (`UrlFilterForm`), so the page's other filters
 * are kept and the pager resets.
 */
export function BranchFilter({
  branches,
  value,
  id = "filter-branch",
  className,
}: {
  branches: BranchFilterOption[];
  value: string;
  id?: string;
  className?: string;
}) {
  const t = useTranslations("TeacherScope");
  return (
    <UrlFilterForm className={className ?? "flex flex-col gap-1.5 sm:w-64"}>
      <Label htmlFor={id}>{t("branch")}</Label>
      <Select
        id={id}
        name="branch"
        defaultValue={value}
        submitOnChange
        options={[
          { value: "", label: t("allBranches") },
          ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
        ]}
      />
    </UrlFilterForm>
  );
}
