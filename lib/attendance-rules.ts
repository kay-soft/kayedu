import type { AttendanceStatus, Prisma } from "@prisma/client";

/**
 * Two attendance rules from T5 (docs/00 §5 "Void vs. refund", "Attendance"),
 * each in exactly one place. Pure — no database client — so the data layer,
 * the gates and client components all read the same answer.
 *
 * 1. **A drop-in's ABSENT row is never an absence.** A drop-in has no
 *    enrolment, so nothing expected them: an ABSENT row for one is what a
 *    voided or refunded check-in leaves behind on a live session (the row is
 *    kept — payments cascade from it, CLAUDE.md rule 2), a "never really came"
 *    record. It is not counted in the receipt's absences, absence streaks, the
 *    student profile's absence alert, analytics, or a student's/parent's past
 *    sessions. An enrolled student's ABSENT row is a genuine absence once the
 *    session closes, exactly as before.
 * 2. **"Not arrived".** On a live (not yet closed) session an ABSENT row means
 *    "not checked in" — it is shown as Not arrived, never as Absent, and is
 *    not in any checked-in count. A drop-in's ABSENT row reads the same way
 *    once the session closes (rule 1).
 */

/** `isDropIn` AND `ABSENT` — the "never really came" record of rule 1. */
export function isDropInNoShow(row: { isDropIn: boolean; attendanceStatus: AttendanceStatus }): boolean {
  return row.isDropIn && row.attendanceStatus === "ABSENT";
}

/**
 * Rule 1 as a `SessionAttendee` filter — spread into every reader that counts
 * or lists absences or past attendance (`NOT (isDropIn AND ABSENT)`).
 */
export const EXCLUDE_DROP_IN_NO_SHOWS = {
  NOT: { isDropIn: true, attendanceStatus: "ABSENT" },
} as const satisfies Prisma.SessionAttendeeWhereInput;

/** What a roster, receipt or history shows for one row. */
export type AttendanceDisplay = AttendanceStatus | "NOT_ARRIVED";

/** Rule 2: an ABSENT row on a live session — or a drop-in's, ever — reads "Not arrived". */
export function attendanceDisplay(
  row: { isDropIn: boolean; attendanceStatus: AttendanceStatus },
  sessionClosed: boolean,
): AttendanceDisplay {
  if (row.attendanceStatus !== "ABSENT") return row.attendanceStatus;
  return !sessionClosed || row.isDropIn ? "NOT_ARRIVED" : "ABSENT";
}
