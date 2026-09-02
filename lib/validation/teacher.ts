import { z } from "zod";

// Relative imports on purpose, matching lib/validation/sessions.ts and
// lib/validation/classes.ts: this module stays resolvable outside the
// Next.js runtime.
import { localeSchema } from "./auth.ts";
import { isValidTime } from "../scheduling.ts";

/**
 * Teacher portal schemas (M7). Every Server Action under
 * `app/[locale]/(teacher)/teacher/**\/actions.ts` parses its input through
 * one of these before touching the database (docs/02 §7).
 *
 * A teacher-scoped action never trusts a client-sent `teacherId`/`userId` for
 * "which teacher is this" — that always comes from `ctx.user.id` in the
 * action itself, never from the form. These schemas deliberately carry no
 * such field.
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

const optionalRef = z
  .string()
  .trim()
  .max(64, "notFound")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null));

const checkbox = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "true");

const wholeNumber = (max: number) =>
  z
    .string()
    .trim()
    .default("0")
    .transform((value) => (value === "" ? 0 : Number(value)))
    .refine(
      (value) => Number.isInteger(value) && value >= 0 && value <= max,
      "invalidNumber",
    );

const base = { locale: localeSchema };

// ── Sessions: list filters, description edit ────────────────────────────────

export const teacherSessionRangeSchema = z.enum(["day", "week", "month"]);

export const teacherSessionListFilterSchema = z.object({
  range: teacherSessionRangeSchema.default("week"),
  date: z
    .string()
    .trim()
    .max(10)
    .optional()
    .transform((value) =>
      value && !Number.isNaN(Date.parse(value)) ? value.slice(0, 10) : null,
    ),
  gradeId: optionalRef,
  status: z
    .enum(["SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"])
    .optional()
    .transform((value) => value ?? null),
  q: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

/**
 * Session-description edit (spec §4.2 item 2). No teacher edit-deadline
 * setting exists yet (docs/00 §5 "Attendance" M5 note) — flagged as a gap,
 * not enforced here, exactly like M5 left it for center staff.
 */
export const teacherSessionDescriptionSchema = z.object({
  ...base,
  sessionId: recordId,
  description: optionalText(500),
});

// ── Students: block / unblock ───────────────────────────────────────────────

export const teacherBlockStudentSchema = z.object({
  ...base,
  studentProfileId: recordId,
  reason: optionalText(200),
});

export const teacherUnblockStudentSchema = z.object({
  ...base,
  blockId: recordId,
});

// ── Classes: request a new class (ChangeRequest, spec §4.2 item 4) ─────────

const dayOfWeek = z
  .string()
  .trim()
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= 6, "invalidDay");

const timeValue = z
  .string()
  .trim()
  .refine((value) => isValidTime(value), "invalidTime");

export const MAX_REQUEST_CAPACITY = 1_000;
export const MAX_REQUEST_LATE_THRESHOLD_MINUTES = 240;

export const classRequestSchema = z
  .object({
    ...base,
    subjectId: optionalRef,
    gradeId: optionalRef,
    dayOfWeek,
    startTime: timeValue,
    endTime: timeValue,
    capacity: wholeNumber(MAX_REQUEST_CAPACITY),
    attendanceRequired: checkbox,
    lateThresholdMinutes: wholeNumber(MAX_REQUEST_LATE_THRESHOLD_MINUTES),
    note: optionalText(300),
  })
  .refine((value) => value.startTime < value.endTime, {
    path: ["endTime"],
    message: "invalidTimeRange",
  });

// ── Action state ────────────────────────────────────────────────────────────

export type TeacherActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "created" | "saved" | "deleted";
};

export const IDLE_TEACHER_STATE: TeacherActionState = {};
