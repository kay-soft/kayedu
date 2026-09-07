"use client";

import { useTranslations } from "next-intl";

import { DateFilter, type DateFilterValue } from "@/components/shared/date-filter";
import { SelectInput } from "@/components/ui/select-input";

export type SelectOption = { value: string; label: string };

/**
 * Today's Sessions dashboard filters (spec §4.1 item 7 "filterable...by
 * date/week/month, teacher, subject, class, status"). A plain GET form —
 * filter state lives in the URL, and changing any control re-submits
 * immediately, matching `ClassFilters`. The date portion is the one shared
 * `DateFilter` component (M18, docs/04 §11.7) every other date-filtered
 * screen in the app also renders.
 */
export function SessionFilters({
  dateFilter,
  todayIso,
  resetHref,
  teacherId,
  subjectId,
  classGroupId,
  status,
  teachers,
  subjects,
  classes,
  allLabel,
}: {
  dateFilter: DateFilterValue;
  todayIso: string;
  resetHref: string;
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
      <DateFilter value={dateFilter} todayIso={todayIso} resetHref={resetHref} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
