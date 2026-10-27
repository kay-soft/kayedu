"use client";

import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { FilterBar, FilterField } from "@/components/shared/filter-bar";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

export type GradeChoice = { value: string; label: string };

/**
 * Step 1 — From grade → To grade (docs/04 §11.23). Plain URL state through the
 * one shared filter form: Preview puts `?from=&to=` in the address bar, the
 * page reads them, and Back undoes it. The To list is only the grades still on
 * offer; **nothing is pre-selected for To** because the catalog has no grade
 * order (docs/00 §5.1) — the admin picks.
 */
export function PromoteSelectors({
  from,
  to,
  fromGrades,
  toGrades,
}: {
  from: string;
  to: string;
  fromGrades: GradeChoice[];
  toGrades: GradeChoice[];
}) {
  const t = useTranslations("Students.promote");

  return (
    <FilterBar className="sm:items-end">
      <FilterField label={t("from")} htmlFor="promote-from" className="sm:min-w-56">
        <Select id="promote-from" name="from" defaultValue={from} placeholder={t("chooseGrade")} required>
          {fromGrades.map((grade) => (
            <option key={grade.value} value={grade.value}>
              {grade.label}
            </option>
          ))}
        </Select>
      </FilterField>
      <FilterField label={t("to")} htmlFor="promote-to" className="sm:min-w-56">
        <Select id="promote-to" name="to" defaultValue={to} placeholder={t("chooseGrade")} required>
          {toGrades.map((grade) => (
            <option key={grade.value} value={grade.value}>
              {grade.label}
            </option>
          ))}
        </Select>
      </FilterField>
      <Button type="submit" className="h-11 w-full sm:w-auto">
        {t("preview")}
        <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
      </Button>
    </FilterBar>
  );
}
