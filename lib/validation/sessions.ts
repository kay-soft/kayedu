import { z } from "zod";

// Relative imports on purpose, matching lib/validation/classes.ts and
// lib/validation/people.ts: this module and everything it pulls in stay
// resolvable outside the Next.js runtime, so `npm run check:payments` can
// exercise the real schemas the same way `check:classes` exercises
// classGroupSchema.
import { localeSchema } from "./auth.ts";
import { normalizeEmail, normalizePhone } from "../identity.ts";
import { MAX_PIASTRES, parseEgpToPiastres } from "../money.ts";

/**
 * Session, attendance, payment and Reception Desk schemas (M5). Every Server
 * Action parses its input through one of these before touching the database
 * (docs/02 §7).
 *
 * Messages are **i18n keys** under `Sessions.errors`, never user-facing copy.
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

const optionalRef = z
  .string()
  .trim()
  .max(64, "notFound")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

const personName = z.string().trim().min(1, "required").max(60, "tooLong");

const optionalEmail = z
  .string()
  .trim()
  .max(254, "tooLong")
  .optional()
  .transform((value) => normalizeEmail(value))
  .refine(
    (value) => value === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    "invalidEmail",
  );

const optionalPhone = z
  .string()
  .trim()
  .max(20, "tooLong")
  .optional()
  .transform((value, ctx) => {
    if (!value || value.length === 0) return null;
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "invalidPhone" });
      return z.NEVER;
    }
    return normalized;
  });

const base = { locale: localeSchema };

const attendanceStatus = z.enum(["PRESENT", "LATE", "ABSENT", "EXCUSED"], {
  error: "invalidStatus",
});

const paymentMethod = z.enum(["CASH", "INSTAPAY", "WALLET", "VISA"], {
  error: "invalidMethod",
});

// ── Today's Sessions dashboard filters ──────────────────────────────────────

export const sessionRangeSchema = z.enum(["day", "week", "month"]);

export const sessionListFilterSchema = z.object({
  range: sessionRangeSchema.default("day"),
  /** Anchor date, "YYYY-MM-DD" — absent means today. */
  date: z
    .string()
    .trim()
    .max(10)
    .optional()
    .transform((value) =>
      value && !Number.isNaN(Date.parse(value)) ? value.slice(0, 10) : null,
    ),
  teacherId: optionalRef,
  subjectId: optionalRef,
  classGroupId: optionalRef,
  status: z
    .enum(["SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"])
    .optional()
    .transform((value) => value ?? null),
});

// ── Attendance (mark / correct) ─────────────────────────────────────────────

export const setAttendanceSchema = z.object({
  ...base,
  sessionId: recordId,
  studentProfileId: recordId,
  status: attendanceStatus,
});

// ── Add student to a session's roster ───────────────────────────────────────

/** An existing student found by search — enrolled or drop-in, decided server-side. */
export const addExistingAttendeeSchema = z.object({
  ...base,
  sessionId: recordId,
  studentProfileId: recordId,
  status: attendanceStatus,
});

/**
 * A brand-new student, added directly as a drop-in (spec §4.1 item 7). Kept
 * intentionally slim — name + contact only — because this is a fast add at
 * the point of attendance; grade and parent details are filled in later from
 * the student's own profile (`lib/db/identity.ts` seeds/edits them exactly
 * like the Students screen does).
 */
export const addNewAttendeeSchema = z.object({
  ...base,
  sessionId: recordId,
  firstName: personName,
  lastName: personName,
  email: optionalEmail,
  phone: optionalPhone,
  status: attendanceStatus,
  /** Present only after the duplicate-match panel has been confirmed. */
  linkUserId: optionalRef,
});

// ── Payment ──────────────────────────────────────────────────────────────

export const recordPaymentSchema = z.object({
  ...base,
  sessionAttendeeId: recordId,
  method: paymentMethod,
});

export const voidPaymentSchema = z.object({
  ...base,
  paymentId: recordId,
  reason: z.string().trim().min(1, "required").max(200, "tooLong"),
});

// ── Refund (M14, spec §4.1 item 12) ─────────────────────────────────────────
// Same shape as voidPaymentSchema on purpose: a refund and a void are both
// "which payment, why" — the mechanism they trigger differs (CLAUDE.md rule
// 7), the input shape does not.

export const refundPaymentSchema = z.object({
  ...base,
  paymentId: recordId,
  reason: z.string().trim().min(1, "required").max(200, "tooLong"),
});

// ── Session lifecycle: cancel / reschedule (M10) ────────────────────────────

export const cancelSessionSchema = z.object({
  ...base,
  sessionId: recordId,
});

const sessionDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), "invalidDate")
  .transform((value) => new Date(`${value.slice(0, 10)}T00:00:00.000Z`));

const sessionTime = z
  .string()
  .trim()
  .refine((value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(value), "invalidTime");

export const rescheduleSessionSchema = z
  .object({
    ...base,
    sessionId: recordId,
    date: sessionDate,
    startTime: sessionTime,
    endTime: sessionTime,
  })
  .refine((value) => value.startTime < value.endTime, {
    path: ["endTime"],
    message: "invalidTimeRange",
  });

// ── Per-session centre-cut override (M13, spec §5.1 "Center cut") ─────────

/**
 * `override` unchecked clears this session back to inheriting the class's
 * own cut; checked applies `centerShareType`/`shareValue` as this one
 * session's override — the same FIXED-piastres/PERCENTAGE-percent resolution
 * `classGroupFields` uses in `lib/validation/classes.ts`, just for one row.
 */
export const sessionShareOverrideSchema = z
  .object({
    ...base,
    sessionId: recordId,
    override: z
      .string()
      .optional()
      .transform((value) => value === "on" || value === "true"),
    centerShareType: z.enum(["FIXED", "PERCENTAGE"], { error: "invalidShareType" }),
    shareValue: z.string().trim().default("0"),
  })
  .transform((value, ctx) => {
    if (!value.override) {
      return { locale: value.locale, sessionId: value.sessionId, override: null };
    }
    if (value.centerShareType === "PERCENTAGE") {
      const percent = Number(value.shareValue);
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
        ctx.addIssue({ code: "custom", path: ["shareValue"], message: "invalidPercent" });
        return z.NEVER;
      }
      return {
        locale: value.locale,
        sessionId: value.sessionId,
        override: { centerShareType: value.centerShareType, centerShareValue: percent },
      };
    }
    const piastres = parseEgpToPiastres(value.shareValue);
    if (piastres === null || piastres > MAX_PIASTRES) {
      ctx.addIssue({ code: "custom", path: ["shareValue"], message: "invalidAmount" });
      return z.NEVER;
    }
    return {
      locale: value.locale,
      sessionId: value.sessionId,
      override: { centerShareType: value.centerShareType, centerShareValue: piastres },
    };
  });

// ── Reception Desk (attendance + payment in one submit) ────────────────────

export const receptionCheckInSchema = z.object({
  ...base,
  sessionId: recordId,
  studentProfileId: recordId,
  status: attendanceStatus,
  /** Absent = mark attendance only, no payment (spec §5 "No debt"). */
  method: paymentMethod.optional(),
});

// ── Action state ────────────────────────────────────────────────────────────

/**
 * A person who already exists, surfaced before anything is linked — the same
 * shape `lib/db/identity.ts`'s `describeMatch` returns for the Students
 * screen (spec §5, never a silent merge).
 */
export type SessionMatchCandidate = {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  matchedOn: ("email" | "phone")[];
  existingHere: "student" | "teacher" | "staff" | null;
  existingProfileId?: string;
};

export type SessionActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?:
    | "created"
    | "saved"
    | "deleted"
    | "matchFound"
    | "voided"
    | "refunded"
    | "cancelled"
    | "rescheduled"
    | "shareUpdated";
  match?: SessionMatchCandidate;
  conflicts?: { type: "teacher" | "room"; className: string }[];
};

export const IDLE_SESSION_STATE: SessionActionState = {};
