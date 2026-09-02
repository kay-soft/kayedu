"use client";

import { useTranslations } from "next-intl";

import { SelectInput } from "@/components/ui/select-input";

export type DateRangeValue = "day" | "week" | "month" | "year" | "all";

/**
 * The date-range filter shared by Analytics and Expenses (spec §4.1 items 5
 * & 6: "same date filters as Analytics") — day/week/month/year/all-time/
 * specific date. A plain GET form — filter state lives in the URL, matching
 * `SessionFilters` (docs/02 §14: shareable, back-button-safe).
 */
export function DateRangeFilters({
  range,
  date,
  namespace,
  children,
}: {
  range: DateRangeValue;
  date: string;
  /** Which `*.filters` message namespace to read range/date labels from. */
  namespace: "Expenses" | "Analytics";
  /** Extra filter controls (e.g. Analytics' teacher select) in the same form. */
  children?: React.ReactNode;
}) {
  const t = useTranslations(`${namespace}.filters`);

  return (
    <form className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-48">
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
          <option value="year">{t("rangeYear")}</option>
          <option value="all">{t("rangeAll")}</option>
        </SelectInput>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:max-w-48">
        <label htmlFor="filter-date" className="text-xs font-medium text-text-secondary">
          {t("date")}
        </label>
        <input
          id="filter-date"
          name="date"
          type="date"
          dir="ltr"
          defaultValue={date}
          disabled={range === "all"}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className="h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25 disabled:opacity-50"
        />
      </div>

      {children}
    </form>
  );
}
