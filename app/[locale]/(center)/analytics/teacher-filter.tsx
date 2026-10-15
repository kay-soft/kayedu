"use client";

import { useTranslations } from "next-intl";

import { FilterField } from "@/components/shared/filter-bar";
import { Select } from "@/components/ui/select";

export type TeacherOption = { value: string; label: string };

/**
 * The "by teacher" dimension of the Analytics filters (spec §4.1 item 5): the
 * shared `Select` (docs/04 §5) inside the shared filter-row field
 * (docs/04 §5 "Filter row"), re-querying as soon as a teacher is picked.
 */
export function TeacherFilter({
  teacherId,
  teachers,
}: {
  teacherId: string;
  teachers: TeacherOption[];
}) {
  const t = useTranslations("Analytics.filters");

  return (
    <FilterField
      label={t("teacher")}
      htmlFor="filter-teacherId"
      className="sm:w-60"
    >
      <Select
        id="filter-teacherId"
        name="teacherId"
        defaultValue={teacherId}
        submitOnChange
        options={[{ value: "", label: t("allTeachers") }, ...teachers]}
      />
    </FilterField>
  );
}
