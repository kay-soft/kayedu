"use client";

import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";

/**
 * The student schedule's date filter (spec §4.3 item 1). A plain GET form —
 * state lives in the URL, the same pattern as the center/teacher session
 * filters.
 *
 * The control is the shared `DatePicker` (docs/04 §5 "Date control"), so this
 * screen gets the app's own calendar in the app's own locale and direction,
 * rather than the browser's. "Clear" is the picker's own inline affordance
 * now, not a second button competing with the field beside it — the empty
 * value *is* "any date", so it belongs inside the control that holds it.
 */
export function ScheduleDateFilter({
  date,
  todayIso,
  dateLabel,
}: {
  date: string;
  /** Today, from the server — the same "now" the schedule query resolves against. */
  todayIso: string;
  dateLabel: string;
}) {
  return (
    <form className="flex flex-col gap-1.5 sm:w-64">
      <Label htmlFor="schedule-date">{dateLabel}</Label>
      <DatePicker
        id="schedule-date"
        name="date"
        defaultValue={date}
        todayIso={todayIso}
        clearable
        submitOnChange
      />
    </form>
  );
}
