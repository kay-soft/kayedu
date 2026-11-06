"use client";

import { useTranslations } from "next-intl";

import { FilterField } from "@/components/shared/filter-bar";
import { UrlFilterForm } from "@/components/shared/url-filters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RESULT_SORTS, RESULT_STATUSES } from "@/lib/assessment-results";

/**
 * Search by name, filter by status, sort by name, score or time taken (W4, D-W33).
 * State lives in the URL (a soft GET through `UrlFilterForm`, docs/02 §14), and the
 * page does the work in memory, so the summary above stays the whole class's.
 */
export function ResultsFilters({ query, status, sort }: { query: string; status: string; sort: string }) {
  const t = useTranslations("TeacherAssessments.results");

  return (
    <UrlFilterForm className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_14rem_auto] md:items-end">
      <FilterField label={t("filters.search")} htmlFor="results-search">
        <Input
          key={query}
          id="results-search"
          name="q"
          type="search"
          className="h-11"
          defaultValue={query}
          placeholder={t("filters.searchPlaceholder")}
        />
      </FilterField>
      <FilterField label={t("filters.status")} htmlFor="results-status">
        <Select
          id="results-status"
          name="status"
          defaultValue={status}
          submitOnChange
          options={[
            { value: "", label: t("filters.allStatuses") },
            ...RESULT_STATUSES.map((value) => ({ value, label: t(`status.${value}`) })),
          ]}
        />
      </FilterField>
      <FilterField label={t("filters.sort")} htmlFor="results-sort">
        <Select
          id="results-sort"
          name="sort"
          defaultValue={sort}
          submitOnChange
          options={RESULT_SORTS.map((value) => ({ value, label: t(`filters.sorts.${value}`) }))}
        />
      </FilterField>
      <Button type="submit" variant="outline" className="h-11">
        {t("filters.apply")}
      </Button>
    </UrlFilterForm>
  );
}
