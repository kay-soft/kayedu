"use client";

/**
 * Auto-submitting date filter for the student schedule (spec §4.3 item 1).
 * A plain GET form — state lives in the URL, the same pattern as the
 * center/teacher session filters. Needs "use client": the `onChange` handler
 * can't be passed to a DOM element from a Server Component.
 */
export function ScheduleDateFilter({
  date,
  dateLabel,
  clearLabel,
}: {
  date: string;
  dateLabel: string;
  clearLabel: string;
}) {
  return (
    <form className="flex flex-col gap-1.5 sm:w-64">
      <label htmlFor="schedule-date" className="text-xs font-medium text-text-secondary">
        {dateLabel}
      </label>
      <div className="flex gap-2">
        <input
          id="schedule-date"
          name="date"
          type="date"
          defaultValue={date}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
          className="h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25"
        />
        {date ? (
          <a
            href="?"
            className="flex h-11 shrink-0 items-center justify-center rounded-lg border border-border px-3 text-sm text-text-secondary hover:bg-surface-subtle"
          >
            {clearLabel}
          </a>
        ) : null}
      </div>
    </form>
  );
}
