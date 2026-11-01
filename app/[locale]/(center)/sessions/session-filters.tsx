"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { DateFilter, type DateFilterValue } from "@/components/shared/date-filter";
import { FilterBar, FilterField } from "@/components/shared/filter-bar";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

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
  moved,
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
  /** U2 — "Show moved" (off by default): sessions rescheduled away, greyed. */
  moved: boolean;
  teachers: SelectOption[];
  subjects: SelectOption[];
  classes: SelectOption[];
  allLabel: string;
}) {
  const t = useTranslations("Sessions.filters");
  const tStatus = useTranslations("Sessions.status");

  return (
    <FilterBar className="sm:flex-col sm:items-stretch">
      <DateFilter value={dateFilter} todayIso={todayIso} resetHref={resetHref} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

        <FilterField label={t("teacher")} htmlFor="filter-teacherId">
          <Select
            id="filter-teacherId"
            name="teacherId"
            defaultValue={teacherId}
            submitOnChange
          >
            <option value="">{allLabel}</option>
            {teachers.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label={t("subject")} htmlFor="filter-subjectId">
          <Select
            id="filter-subjectId"
            name="subjectId"
            defaultValue={subjectId}
            submitOnChange
          >
            <option value="">{allLabel}</option>
            {subjects.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label={t("class")} htmlFor="filter-classGroupId">
          <Select
            id="filter-classGroupId"
            name="classGroupId"
            defaultValue={classGroupId}
            submitOnChange
          >
            <option value="">{allLabel}</option>
            {classes.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </FilterField>
      </div>

      <ShowMovedSwitch defaultChecked={moved} label={t("showMoved")} />
    </FilterBar>
  );
}

/**
 * U2 — the "Show moved" switch. Like the selects beside it, changing it
 * re-submits the filter form (from an effect, once the new value is
 * rendered). The value travels in a hidden field that is always present —
 * "on", or empty when off — because the soft filter form keeps any param a
 * submit does not mention (`mergeFilterParams`): a switch that posted
 * nothing when off would leave `?moved=on` in the URL. The whole label row is
 * the 44px target; the switch itself is 24px tall.
 */
function ShowMovedSwitch({ defaultChecked, label }: { defaultChecked: boolean; label: string }) {
  const [checked, setChecked] = useState(defaultChecked);
  const rowRef = useRef<HTMLLabelElement>(null);
  const pendingSubmit = useRef(false);

  useEffect(() => {
    if (!pendingSubmit.current) return;
    pendingSubmit.current = false;
    rowRef.current?.closest("form")?.requestSubmit();
  }, [checked]);

  return (
    <label ref={rowRef} className="flex min-h-11 w-fit cursor-pointer items-center gap-3 text-sm text-text-primary">
      <input type="hidden" name="moved" value={checked ? "on" : ""} />
      <Switch
        checked={checked}
        onCheckedChange={(next) => {
          pendingSubmit.current = true;
          setChecked(next);
        }}
      />
      {label}
    </label>
  );
}
