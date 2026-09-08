"use client";

import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";

/**
 * Date filter for the parent schedule mirror (spec §4.5 item 2) — the same
 * shared `DatePicker` the student schedule uses (docs/04 §5 "Date control"),
 * with one addition: a hidden `child` field, so submitting a date never
 * resets the child selector back to the first verified child.
 */
export function ParentDateFilter({
  date,
  childId,
  todayIso,
  dateLabel,
}: {
  date: string;
  childId: string;
  /** Today, from the server — the same "now" the schedule query resolves against. */
  todayIso: string;
  dateLabel: string;
}) {
  return (
    <form className="flex flex-col gap-1.5 sm:w-64">
      <input type="hidden" name="child" value={childId} />
      <Label htmlFor="parent-schedule-date">{dateLabel}</Label>
      <DatePicker
        id="parent-schedule-date"
        name="date"
        defaultValue={date}
        todayIso={todayIso}
        clearable
        submitOnChange
      />
    </form>
  );
}
