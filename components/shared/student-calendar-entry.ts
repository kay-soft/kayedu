import type { CalendarEntry } from "@/components/shared/session-calendar";
import type { CalendarTone } from "@/lib/calendar";
import type { StudentCalendarEntry, StudentCalendarStatus } from "@/lib/db/student-portal";
import { formatTimeRange } from "@/lib/format";
import { dateKey } from "@/lib/scheduling";
import { sessionLabelParts } from "@/lib/session-label";

const TONE: Record<StudentCalendarStatus, CalendarTone> = {
  PRESENT: "present",
  LATE: "late",
  ABSENT: "absent",
  UPCOMING: "upcoming",
  BOOKED: "booked",
  REQUESTED: "requested",
  CANCELLED: "cancelled",
};

/**
 * A student-side calendar entry as `SessionCalendar` draws it (U7) — the
 * student's and the parent's calendars share it, so a child's calendar reads
 * exactly like the child's own.
 */
export function studentCalendarEntry(
  entry: StudentCalendarEntry,
  branchName: string | null,
  locale: string,
  noneLabel: string,
): CalendarEntry {
  const { subjectName, gradeName } = sessionLabelParts(locale, entry.session);
  return {
    id: entry.sessionId,
    day: dateKey(entry.date),
    tone: TONE[entry.status],
    time: formatTimeRange(entry.startTime, entry.endTime, locale),
    startTime: entry.startTime,
    title: [subjectName, gradeName].filter(Boolean).join(" · ") || noneLabel,
    branch: branchName,
    room: entry.roomName,
  };
}
