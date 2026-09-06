"use client";

import { useTranslations } from "next-intl";

import { SelectInput } from "@/components/ui/select-input";

export type SelectOption = { value: string; label: string };

/**
 * Today's Sessions dashboard filters (spec §4.1 item 7 "filterable...by
 * date/week/month, teacher, subject, class, status"). A plain GET form —
 * filter state lives in the URL, and changing any control re-submits
 * immediately, matching `ClassFilters`.
 */
export function SessionFilters({
  range,
  date,
  teacherId,
  subjectId,
  classGroupId,
  status,
  teachers,
  subjects,
  classes,
  allLabel,
}: {
  range: "day" | "week" | "month";
  date: string;
  teacherId: string;
  subjectId: string;
  classGroupId: string;
  status: string;
  teachers: SelectOption[];
  subjects: SelectOption[];
  classes: SelectOption[];
  allLabel: string;
}) {
  const t = useTranslations("Sessions.filters");
  const tStatus = useTranslations("Sessions.status");

  return (
    <form className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="filter-date" className="text-xs font-medium text-text-secondary">
            {t("date")}
          </label>
          <input
            id="filter-date"
            name="date"
            type="date"
            defaultValue={date}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
            className="h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="filter-range" className="text-xs font-medium text-text-secondary">
            {t("range")}
          </label>
          <SelectInput
            id="filter-range"
            name="range"
            defaultValue={range}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
          >
            <option value="day">{t("rangeDay")}</option>
            <option value="week">{t("rangeWeek")}</option>
            <option value="month">{t("rangeMonth")}</option>
          </SelectInput>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="filter-status" className="text-xs font-medium text-text-secondary">
            {t("status")}
          </label>
          <SelectInput
            id="filter-status"
            name="status"
            defaultValue={status}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
          >
            <option value="">{allLabel}</option>
            <option value="SCHEDULED">{tStatus("SCHEDULED")}</option>
            <option value="LIVE">{tStatus("LIVE")}</option>
            <option value="COMPLETED">{tStatus("COMPLETED")}</option>
            <option value="CANCELLED">{tStatus("CANCELLED")}</option>
          </SelectInput>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="filter-teacherId" className="text-xs font-medium text-text-secondary">
            {t("teacher")}
          </label>
          <SelectInput
            id="filter-teacherId"
            name="teacherId"
            defaultValue={teacherId}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
          >
            <option value="">{allLabel}</option>
            {teachers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="filter-subjectId" className="text-xs font-medium text-text-secondary">
            {t("subject")}
          </label>
          <SelectInput
            id="filter-subjectId"
            name="subjectId"
            defaultValue={subjectId}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
          >
            <option value="">{allLabel}</option>
            {subjects.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="filter-classGroupId" className="text-xs font-medium text-text-secondary">
            {t("class")}
          </label>
          <SelectInput
            id="filter-classGroupId"
            name="classGroupId"
            defaultValue={classGroupId}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
          >
            <option value="">{allLabel}</option>
            {classes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectInput>
        </div>
      </div>
    </form>
  );
}
