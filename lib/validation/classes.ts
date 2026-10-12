import { z } from "zod";

// Relative imports on purpose: this module and everything it pulls in stay
// resolvable outside the Next.js runtime, so `npm run check:classes` can
// exercise the real schemas (same reasoning as ./settings.ts and ./people.ts).
import { localeSchema } from "./auth.ts";
import { MAX_PIASTRES, parseEgpToPiastres } from "../money.ts";
import { isValidTime } from "../scheduling.ts";

/**
 * Class, schedule, enrollment and holiday schemas (M4). Every Server Action
 * parses its input through one of these before touching the database
 * (docs/02 §7).
 *
 * Messages are **i18n keys** under `Classes.errors`, never user-facing copy.
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

const moneyEgp = z
  .string()
  .trim()
  .default("0")
  .transform((value) => (value === "" ? 0 : parseEgpToPiastres(value)))
  .refine((value): value is number => value !== null, "invalidAmount");

const MAX_CAPACITY = 1_000;
export const MAX_LATE_THRESHOLD_MINUTES = 240;

const base = { locale: localeSchema };

// ── Class group ─────────────────────────────────────────────────────────────

/**
 * `shareValue` means a percent or an EGP amount depending on `shareType` —
 * resolved in the transform exactly like `generalSettingsSchema` in
 * settings.ts, so the two "center cut" forms behave identically.
 */
const classGroupFields = {
  teacherId: recordId,
  subjectId: optionalRef,
  gradeId: optionalRef,
  educationSystemId: optionalRef,
  roomId: optionalRef,
  price: moneyEgp,
  centerShareType: z.enum(["FIXED", "PERCENTAGE"], { error: "invalidShareType" }),
  shareValue: z.string().trim().min(1, "required"),
  capacity: wholeNumber(MAX_CAPACITY),
  lateThresholdMinutes: wholeNumber(MAX_LATE_THRESHOLD_MINUTES),
  acceptsNewStudents: checkbox,
  requiresConfirmation: checkbox,
};

function resolveShareValue(
  value: { centerShareType: "FIXED" | "PERCENTAGE"; shareValue: string },
  ctx: z.RefinementCtx,
): number | typeof z.NEVER {
  if (value.centerShareType === "PERCENTAGE") {
    const percent = Number(value.shareValue);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      ctx.addIssue({ code: "custom", path: ["shareValue"], message: "invalidPercent" });
      return z.NEVER;
    }
    return percent;
  }
  const piastres = parseEgpToPiastres(value.shareValue);
  if (piastres === null || piastres > MAX_PIASTRES) {
    ctx.addIssue({ code: "custom", path: ["shareValue"], message: "invalidAmount" });
    return z.NEVER;
  }
  return piastres;
}

export const classGroupSchema = z
  .object({ ...base, ...classGroupFields })
  .transform((value, ctx) => {
    const centerShareValue = resolveShareValue(value, ctx);
    if (centerShareValue === z.NEVER) return z.NEVER;
    return {
      locale: value.locale,
      teacherId: value.teacherId,
      subjectId: value.subjectId,
      gradeId: value.gradeId,
      educationSystemId: value.educationSystemId,
      roomId: value.roomId,
      price: value.price,
      centerShareType: value.centerShareType,
      centerShareValue,
      capacity: value.capacity,
      lateThresholdMinutes: value.lateThresholdMinutes,
      acceptsNewStudents: value.acceptsNewStudents,
      requiresConfirmation: value.requiresConfirmation,
    };
  });

export const classGroupUpdateSchema = z
  .object({ ...base, ...classGroupFields, id: recordId })
  .transform((value, ctx) => {
    const centerShareValue = resolveShareValue(value, ctx);
    if (centerShareValue === z.NEVER) return z.NEVER;
    return {
      locale: value.locale,
      id: value.id,
      teacherId: value.teacherId,
      subjectId: value.subjectId,
      gradeId: value.gradeId,
      educationSystemId: value.educationSystemId,
      roomId: value.roomId,
      price: value.price,
      centerShareType: value.centerShareType,
      centerShareValue,
      capacity: value.capacity,
      lateThresholdMinutes: value.lateThresholdMinutes,
      acceptsNewStudents: value.acceptsNewStudents,
      requiresConfirmation: value.requiresConfirmation,
    };
  });

export const classRecordSchema = z.object({ ...base, id: recordId });

export const classActiveSchema = z.object({
  ...base,
  id: recordId,
  active: checkbox,
});

// ── Class schedule (the Schedule Builder, docs/04 §9) ──────────────────────

const dayOfWeek = z
  .string()
  .trim()
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= 6, "invalidDay");

const timeValue = z
  .string()
  .trim()
  .refine((value) => isValidTime(value), "invalidTime");

const scheduleFields = {
  classGroupId: recordId,
  dayOfWeek,
  startTime: timeValue,
  endTime: timeValue,
};

export const classScheduleSchema = z
  .object({ ...base, ...scheduleFields })
  .refine((value) => value.startTime < value.endTime, {
    path: ["endTime"],
    message: "invalidTimeRange",
  });

export const classScheduleUpdateSchema = z
  .object({ ...base, ...scheduleFields, id: recordId })
  .refine((value) => value.startTime < value.endTime, {
    path: ["endTime"],
    message: "invalidTimeRange",
  });

export const classScheduleDeleteSchema = z.object({ ...base, id: recordId });

// ── Enrollment (add / remove / block a student to/from a class) ───────────

export const enrollmentCreateSchema = z.object({
  ...base,
  classGroupId: recordId,
  studentProfileId: recordId,
});

export const enrollmentActionSchema = z.object({
  ...base,
  enrollmentId: recordId,
});

export const classBlockCreateSchema = z.object({
  ...base,
  classGroupId: recordId,
  studentProfileId: recordId,
  reason: optionalText(200),
});

// ── Holiday calendar ────────────────────────────────────────────────────────

const holidayDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), "invalidDate")
  .transform((value) => new Date(`${value.slice(0, 10)}T00:00:00.000Z`));

export const holidaySchema = z.object({
  ...base,
  date: holidayDate,
  name: optionalText(120),
});

export const holidayDeleteSchema = z.object({ ...base, id: recordId });

// ── Session generation trigger ─────────────────────────────────────────────

export const generateSessionsSchema = z.object({
  ...base,
  /** Absent = regenerate for the whole center. */
  classGroupId: optionalRef,
});

// ── List filters (classes dashboard) ────────────────────────────────────────

export const classListFilterSchema = z.object({
  teacherId: optionalRef,
  subjectId: optionalRef,
  gradeId: optionalRef,
});

// ── Action state ────────────────────────────────────────────────────────────

export type ScheduleConflictInfo = {
  type: "teacher" | "room";
  className: string;
};

/**
 * What the class/schedule/enrollment/generation actions return. `error` and
 * the values in `fieldErrors` are i18n keys under `Classes.errors`, not copy.
 * `conflicts` is populated whenever a save/generation surfaced a teacher/room
 * double-booking — under the WARN policy the row is still saved, so the UI
 * needs to show it; under DENY the action returns early with `error` set
 * instead.
 */
export type ClassActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "created" | "saved" | "deleted" | "generated";
  conflicts?: ScheduleConflictInfo[];
  generated?: { created: number; conflicts: number };
};

export const IDLE_CLASS_STATE: ClassActionState = {};
