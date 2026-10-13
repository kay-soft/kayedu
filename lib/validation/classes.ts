import { z } from "zod";

// Relative imports on purpose: this module and everything it pulls in stay
// resolvable outside the Next.js runtime, so `npm run check:classes` can
// exercise the real schemas (same reasoning as ./settings.ts and ./people.ts).
import { localeSchema } from "./auth.ts";
import { MAX_PIASTRES, parseEgpToPiastres } from "../money.ts";
import { isValidTime, weeklySlotsError, type WeeklySlotRow } from "../scheduling.ts";
import {
  confirmConflictsField,
  extraRoomIdsField,
  type SlotConflictState,
} from "./room-set.ts";
import { dateOnlyField, withPeriodRule } from "./class-period.ts";
import type { MatchCandidate } from "./people.ts";

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

export const MAX_LATE_THRESHOLD_MINUTES = 240;

/**
 * R3: every new or edited class must have a primary room — its seat limit
 * is the room set's capacity, so a class without one would be silently
 * uncapped. Existing rows with no room stay valid until next edited.
 */
const requiredRoom = z.string().trim().min(1, "roomRequired").max(64, "notFound");

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
  roomId: requiredRoom,
  extraRoomIds: extraRoomIdsField,
  price: moneyEgp,
  centerShareType: z.enum(["FIXED", "PERCENTAGE"], { error: "invalidShareType" }),
  shareValue: z.string().trim().min(1, "required"),
  lateThresholdMinutes: wholeNumber(MAX_LATE_THRESHOLD_MINUTES),
  acceptsNewStudents: checkbox,
  requiresConfirmation: checkbox,
  // R4 — the class's period, required on every new and edited class. A term
  // preset only fills these two; nothing about the term is posted.
  startDate: dateOnlyField,
  endDate: dateOnlyField,
  confirmConflicts: confirmConflictsField,
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
  .superRefine(withPeriodRule)
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
      extraRoomIds: value.extraRoomIds,
      price: value.price,
      centerShareType: value.centerShareType,
      centerShareValue,
      lateThresholdMinutes: value.lateThresholdMinutes,
      acceptsNewStudents: value.acceptsNewStudents,
      requiresConfirmation: value.requiresConfirmation,
      startDate: value.startDate,
      endDate: value.endDate,
      confirmConflicts: value.confirmConflicts,
    };
  });

export const classGroupUpdateSchema = z
  .object({ ...base, ...classGroupFields, id: recordId })
  .superRefine(withPeriodRule)
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
      extraRoomIds: value.extraRoomIds,
      price: value.price,
      centerShareType: value.centerShareType,
      centerShareValue,
      lateThresholdMinutes: value.lateThresholdMinutes,
      acceptsNewStudents: value.acceptsNewStudents,
      requiresConfirmation: value.requiresConfirmation,
      startDate: value.startDate,
      endDate: value.endDate,
      confirmConflicts: value.confirmConflicts,
    };
  });

// ── Weekly rows of a new class (R6) ─────────────────────────────────────────

/** More than this many weekly rows is a typo, not a timetable. */
export const MAX_WEEKLY_SLOT_ROWS = 14;

/**
 * The class dialog's weekly rows, posted as one JSON field (`slots`). A new
 * class needs at least one; rows on the same weekday must not overlap
 * (`lib/scheduling.ts`'s `weeklySlotsError`, the one rule). The issue is
 * attached to the `slots` field with an i18n key under `Classes.errors`.
 */
export const classSlotsSchema = z
  .string()
  .trim()
  .default("[]")
  .transform((raw, ctx): WeeklySlotRow[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw === "" ? "[]" : raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "invalidTime" });
      return z.NEVER;
    }
    const rows = z
      .array(
        z.object({
          dayOfWeek: z.number(),
          startTime: z.string(),
          endTime: z.string(),
        }),
      )
      .max(MAX_WEEKLY_SLOT_ROWS, "tooManySlots")
      .safeParse(parsed);
    if (!rows.success) {
      ctx.addIssue({
        code: "custom",
        message: rows.error.issues[0]?.message === "tooManySlots" ? "tooManySlots" : "invalidTime",
      });
      return z.NEVER;
    }
    const problem = weeklySlotsError(rows.data, { required: true });
    if (problem) {
      ctx.addIssue({ code: "custom", message: problem.error });
      return z.NEVER;
    }
    return rows.data;
  });

export const classRecordSchema = z.object({ ...base, id: recordId });

export const classActiveSchema = z.object({
  ...base,
  id: recordId,
  active: checkbox,
  /** Reactivating regenerates the period's sessions — same contract (R4). */
  confirmConflicts: confirmConflictsField,
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

/**
 * The R3 "I understand, create anyway" flag for a slot write, parsed beside
 * the slot itself rather than inside it — the parsed slot is exactly the
 * `ClassSchedule` row, so nothing outside its columns belongs in it.
 */
export const slotConfirmationSchema = z.object({
  confirmConflicts: confirmConflictsField,
});

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

export const classScheduleDeleteSchema = z.object({
  ...base,
  id: recordId,
  confirmConflicts: confirmConflictsField,
});

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

// ── List filters (classes dashboard) ────────────────────────────────────────

export const classListFilterSchema = z.object({
  teacherId: optionalRef,
  subjectId: optionalRef,
  gradeId: optionalRef,
});

// ── Action state ────────────────────────────────────────────────────────────

/**
 * What the class/schedule/enrollment actions return. `error` and the values
 * in `fieldErrors` are i18n keys under `Classes.errors`, not copy.
 * `conflicts` (R3, print-ready `SlotConflictInfo`) is populated whenever a
 * save found a teacher/room double-booking anywhere in the class's period:
 * with `error` `conflictsNeedConfirmation` (WARN, not yet confirmed —
 * nothing saved), `scheduleConflict` (DENY — refused), or alongside a
 * success status when the person confirmed it.
 *
 * `sessions` (R4) is what the class-sessions engine did to the class's
 * future sessions — created, removed, moved to the new teacher/rooms, and
 * how many were kept because they carry records or custom changes.
 * `blockers` names why a class cannot be deleted.
 */
export type ClassActionState = SlotConflictState & {
  error?: string;
  /** ICU values for `error` (e.g. how many classes still use a room). */
  errorValues?: Record<string, number>;
  fieldErrors?: Record<string, string>;
  status?: "created" | "saved" | "deleted" | "matchFound";
  /** R6 — field errors of the new teacher's own fields (keys under `People.errors`). */
  teacherFieldErrors?: Record<string, string>;
  sessions?: { created: number; deleted: number; updated: number; kept: number; cancelled?: number };
  blockers?: Record<string, number>;
  /**
   * R6 — which half of "create a class with a new teacher" refused. `error`
   * is then the *reason*, and the UI says "The teacher could not be created:
   * …" or "The class could not be created: …".
   */
  part?: "teacher" | "class";
  /** R6 — the person the new teacher's phone/email already belongs to. */
  match?: MatchCandidate;
};

export const IDLE_CLASS_STATE: ClassActionState = {};
