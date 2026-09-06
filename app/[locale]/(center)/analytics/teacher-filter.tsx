"use client";

import { useTranslations } from "next-intl";

import { SelectInput } from "@/components/ui/select-input";

export type TeacherOption = { value: string; label: string };

/** The "by teacher" dimension of the Analytics filters (spec §4.1 item 5). */
export function TeacherFilter({
  teacherId,
  teachers,
}: {
  teacherId: string;
  teachers: TeacherOption[];
}) {
  const t = useTranslations("Analytics.filters");

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-64">
      <label htmlFor="filter-teacherId" className="text-xs font-medium text-text-secondary">
        {t("teacher")}
      </label>
      <SelectInput
        id="filter-teacherId"
        name="teacherId"
        defaultValue={teacherId}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        <option value="">{t("allTeachers")}</option>
        {teachers.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectInput>
    </div>
  );
}
