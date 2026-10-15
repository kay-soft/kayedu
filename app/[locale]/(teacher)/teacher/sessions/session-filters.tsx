"use client";

import { useTranslations } from "next-intl";

import { DatePicker } from "@/components/ui/date-picker";
import { FilterField } from "@/components/shared/filter-bar";
import { Select } from "@/components/ui/select";

export type SelectOption = { value: string; label: string };

/**
 * Filters for the teacher's own session list (spec §4.2 item 2: "filter
 * date/status/grade"). A plain GET form — state lives in the URL, exactly
 * like the center's `SessionFilters`.
 */
export function TeacherSessionFilters({
  range,
  date,
  todayIso,
  gradeId,
  status,
  q,
  grades,
  allLabel,
}: {
  range: "day" | "week" | "month";
  date: string;
  /** Today, from the server — the same "now" the query itself resolves against. */
  todayIso: string;
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
        <FilterField label={t("date")} htmlFor="filter-date">
          <DatePicker
            id="filter-date"
            name="date"
            defaultValue={date}
            todayIso={todayIso}
            clearable
            submitOnChange
          />
        </FilterField>

        <FilterField label={t("range")} htmlFor="filter-range">
          <Select
            id="filter-range"
            name="range"
            defaultValue={range}
            submitOnChange
          >
            <option value="day">{t("rangeDay")}</option>
            <option value="week">{t("rangeWeek")}</option>
            <option value="month">{t("rangeMonth")}</option>
          </Select>
        </FilterField>

        <FilterField label={t("status")} htmlFor="filter-status">
          <Select
            id="filter-status"
            name="status"
            defaultValue={status}
            submitOnChange
          >
            <option value="">{allLabel}</option>
            <option value="SCHEDULED">{tStatus("SCHEDULED")}</option>
            <option value="LIVE">{tStatus("LIVE")}</option>
            <option value="COMPLETED">{tStatus("COMPLETED")}</option>
            <option value="CANCELLED">{tStatus("CANCELLED")}</option>
          </Select>
        </FilterField>

        <FilterField label={t("grade")} htmlFor="filter-gradeId">
          <Select
            id="filter-gradeId"
            name="gradeId"
            defaultValue={gradeId}
            submitOnChange
          >
            <option value="">{allLabel}</option>
            {grades.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </FilterField>
      </div>
    </form>
  );
}
