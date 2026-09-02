"use client";

import { useTranslations } from "next-intl";

import { SelectInput } from "@/components/ui/select-input";

export type SelectOption = { value: string; label: string };

/**
 * Filters for the teacher's own session list (spec §4.2 item 2: "filter
 * date/status/grade"). A plain GET form — state lives in the URL, exactly
 * like the center's `SessionFilters`.
 */
export function TeacherSessionFilters({
  range,
  date,
  gradeId,
  status,
  q,
  grades,
  allLabel,
}: {
  range: "day" | "week" | "month";
  date: string;
  gradeId: string;
  status: string;
  q: string;
  grades: SelectOption[];
  allLabel: string;
}) {
  const t = useTranslations("TeacherSessions.filters");
  const tStatus = useTranslations("Sessions.status");

  return (
    <form className="flex flex-col gap-3">
      {/* Keeps the active student search when a filter control re-submits. */}
      {q ? <input type="hidden" name="q" value={q} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="filter-gradeId" className="text-xs font-medium text-text-secondary">
            {t("grade")}
          </label>
          <SelectInput
            id="filter-gradeId"
            name="gradeId"
            defaultValue={gradeId}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
          >
            <option value="">{allLabel}</option>
            {grades.map((option) => (
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
