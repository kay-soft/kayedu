"use client";

/**
 * Auto-submitting date filter for the parent schedule mirror (spec §4.5 item
 * 2), the same pattern as the student schedule's `ScheduleDateFilter` — with
 * one addition: a hidden `child` field, so submitting a date never resets the
 * child selector back to the first verified child.
 */
export function ParentDateFilter({
  date,
  childId,
  dateLabel,
  clearLabel,
}: {
  date: string;
  childId: string;
  dateLabel: string;
  clearLabel: string;
}) {
  return (
    <form className="flex flex-col gap-1.5 sm:w-64">
      <input type="hidden" name="child" value={childId} />
      <label htmlFor="parent-schedule-date" className="text-xs font-medium text-text-secondary">
        {dateLabel}
      </label>
      <div className="flex gap-2">
        <input
          id="parent-schedule-date"
          name="date"
          type="date"
          defaultValue={date}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className="h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
        />
        {date ? (
          <a
            href={`?child=${encodeURIComponent(childId)}`}
            className="flex h-11 shrink-0 items-center justify-center rounded-lg border border-border px-3 text-sm text-text-secondary hover:bg-surface-subtle"
          >
            {clearLabel}
          </a>
        ) : null}
      </div>
    </form>
  );
}
