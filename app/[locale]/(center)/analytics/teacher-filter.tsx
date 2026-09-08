"use client";

import { useTranslations } from "next-intl";

import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export type TeacherOption = { value: string; label: string };

/**
 * The "by teacher" dimension of the Analytics filters (spec §4.1 item 5).
 *
 * Was a raw native `<select>` — the one control on the screen the browser
 * drew rather than the design system. It is now the shared `Select`
 * (docs/04 §5), which also gives it type-ahead: a branch with forty teachers
 * is a list you want to type into, not scroll.
 *
 * The label is visually hidden from `sm` up so the control sits on the filter
 * bar's single baseline beside the date control, rather than pushing itself
 * half a line taller than everything next to it. It stays in the
 * accessibility tree, and it is visible on a phone where the controls stack.
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
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-64 sm:flex-none sm:gap-0">
      <Label htmlFor="filter-teacherId" className="sm:sr-only">
        {t("teacher")}
      </Label>
      <Select
        id="filter-teacherId"
        name="teacherId"
        defaultValue={teacherId}
        submitOnChange
        aria-label={t("teacher")}
        className="sm:w-56"
        options={[{ value: "", label: t("allTeachers") }, ...teachers]}
      />
    </div>
  );
}
