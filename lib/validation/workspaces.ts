import { z } from "zod";

// Relative imports on purpose, like the other validation modules: the gates
// (`npm run check:workspaces`) parse through the real schemas.
import { localeSchema } from "./auth.ts";
import { dateOnlyField, withPeriodRule } from "./class-period.ts";
import { classSlotsSchema, MAX_LATE_THRESHOLD_MINUTES } from "./classes.ts";
import { confirmConflictsField, type SlotConflictState } from "./room-set.ts";
import { MAX_PRICE_PIASTRES, parseEgpToPiastres } from "../money.ts";
import { isValidTime } from "../scheduling.ts";

/**
 * PERSONAL-workspace form schemas (W8a, D-W38). Messages are i18n keys under
 * `Workspaces.errors` (workspace-only refusals) or `Classes.errors` (the
 * class and session rules the engine shares with branches). None carries a
 * teacher, a room, a booking mode or a terms field: the server forces those.
 * A posted cut is parsed only so the server can refuse anything but the
 * forced PERCENTAGE 0 (`workspaceCutFixed`), never to apply one.
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

const optionalRef = z
  .string()
  .trim()
  .max(64, "notFound")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

const moneyEgp = z
  .string()
  .trim()
  .default("0")
  .transform((value) => (value === "" ? 0 : parseEgpToPiastres(value, MAX_PRICE_PIASTRES)))
  .refine((value): value is number => value !== null, "invalidAmount");

const lateMinutes = z
  .string()
  .trim()
  .default("10")
  .transform((value) => (value === "" ? 0 : Number(value)))
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= MAX_LATE_THRESHOLD_MINUTES, "invalidNumber");

const time = z.string().trim().refine((value) => isValidTime(value), "invalidTime");

const dayOfWeek = z
  .string()
  .trim()
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 0 && value <= 6, "invalidDay");

/** A posted cut, parsed only to be refused unless it is the forced one. */
const postedCutType = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === "FIXED" || value === "PERCENTAGE" ? value : value ? "INVALID" : null));
const postedCutValue = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : Number(value)));

const base = { locale: localeSchema, workspaceId: recordId };

/** A workspace name's length — the same 80 as `WORKSPACE_NAME_MAX` (lib/db/workspaces.ts). */
export const WORKSPACE_NAME_MAX_LENGTH = 80;

const workspaceName = z.string().trim().min(1, "nameRequired").max(WORKSPACE_NAME_MAX_LENGTH, "nameTooLong");

export const workspaceCreateSchema = z.object({ locale: localeSchema, name: workspaceName });

export const workspaceRenameSchema = z.object({ ...base, name: workspaceName });

export const workspaceRecordSchema = z.object(base);

const classFields = {
  educationSystemId: optionalRef,
  gradeId: optionalRef,
  subjectId: optionalRef,
  price: moneyEgp,
  lateThresholdMinutes: lateMinutes,
  startDate: dateOnlyField,
  endDate: dateOnlyField,
  confirmConflicts: confirmConflictsField,
  centerShareType: postedCutType,
  shareValue: postedCutValue,
};

export const workspaceClassCreateSchema = z
  .object({ ...base, ...classFields, slots: classSlotsSchema })
  .superRefine(withPeriodRule);

export const workspaceClassUpdateSchema = z
  .object({ ...base, ...classFields, classId: recordId })
  .superRefine(withPeriodRule);

export const workspaceClassActiveSchema = z.object({
  ...base,
  classId: recordId,
  active: z
    .string()
    .optional()
    .transform((value) => value === "on" || value === "true"),
  confirmConflicts: confirmConflictsField,
});

export const workspaceClassRecordSchema = z.object({ ...base, classId: recordId });

export const workspaceSlotCreateSchema = z
  .object({ ...base, classId: recordId, dayOfWeek, startTime: time, endTime: time, confirmConflicts: confirmConflictsField })
  .refine((value) => value.startTime < value.endTime, { path: ["endTime"], message: "invalidTimeRange" });

export const workspaceSlotRemoveSchema = z.object({
  ...base,
  scheduleId: recordId,
  confirmConflicts: confirmConflictsField,
});

const sessionSlot = {
  date: dateOnlyField,
  startTime: time,
  endTime: time,
  confirmConflicts: confirmConflictsField,
};

export const workspaceSessionCreateSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...base, ...sessionSlot, kind: z.literal("extra"), classId: recordId }),
    z.object({
      ...base,
      ...sessionSlot,
      kind: z.literal("oneOff"),
      title: z.string().trim().min(1, "titleRequired").max(120, "tooLong"),
      price: moneyEgp,
    }),
  ])
  .refine((value) => value.startTime < value.endTime, { path: ["endTime"], message: "invalidTimeRange" });

export const workspaceRescheduleSchema = z
  .object({ ...base, ...sessionSlot, sessionId: recordId })
  .refine((value) => value.startTime < value.endTime, { path: ["endTime"], message: "invalidTimeRange" });

export const workspaceSessionRecordSchema = z.object({ ...base, sessionId: recordId });

/**
 * What every workspace action returns. `error` and the `fieldErrors` values
 * are i18n keys (`Workspaces.errors` first, then `Classes.errors`).
 */
export type WorkspaceActionState = SlotConflictState & {
  error?: string;
  /** ICU values for `error` (the cap's count). */
  errorValues?: Record<string, number>;
  fieldErrors?: Record<string, string>;
  status?: "created" | "saved" | "deleted" | "archived" | "unarchived" | "cancelled" | "rescheduled";
  /** What the class engine did to future sessions. */
  sessions?: { created: number; deleted: number; updated: number; kept: number; cancelled?: number };
  blockers?: Record<string, number>;
  /** The new workspace, after "created". */
  workspaceId?: string;
};

export const IDLE_WORKSPACE_STATE: WorkspaceActionState = {};
