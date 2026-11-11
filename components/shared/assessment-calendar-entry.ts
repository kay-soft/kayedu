import type { CalendarEntry } from "@/components/shared/session-calendar";
import { formatDateTime } from "@/lib/format";

export type AssessmentCalendarLabels = {
  due: (date: string) => string;
  window: (start: string, end: string) => string;
};

/**
 * An exam or a homework as `SessionCalendar` draws it (W3b, D-W32; docs/04
 * §11.28): the student's and the teacher's pages share it. Times are in `zone`:
 * the session's frozen timezone, else the branch's.
 */
export function assessmentCalendarEntry(input: {
  row: {
    id: string;
    type: "EXAM" | "HOMEWORK";
    title: string;
    windowStart: Date | null;
    windowEnd: Date | null;
    deadline: Date | null;
  };
  placement: { day: string; startTime: string };
  zone: string;
  locale: string;
  labels: AssessmentCalendarLabels;
  className: string;
  branch: string | null;
  href: string;
  state: NonNullable<CalendarEntry["assessment"]>["state"];
  attempts?: string;
}): CalendarEntry {
  const { row, zone, locale, labels } = input;
  const at = (value: Date) => formatDateTime(value, locale, zone);
  const time =
    row.type === "HOMEWORK"
      ? row.deadline
        ? labels.due(at(row.deadline))
        : ""
      : row.windowStart && row.windowEnd
        ? labels.window(at(row.windowStart), at(row.windowEnd))
        : row.windowStart
          ? at(row.windowStart)
          : "";
  return {
    id: row.id,
    day: input.placement.day,
    tone: row.type === "EXAM" ? "exam" : "homework",
    time,
    startTime: input.placement.startTime,
    title: row.title,
    branch: input.branch,
    room: null,
    href: input.href,
    assessment: { className: input.className, state: input.state, attempts: input.attempts },
  };
}
