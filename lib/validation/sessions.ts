import { z } from "zod";

// Relative imports on purpose, matching lib/validation/classes.ts and
// lib/validation/people.ts: this module and everything it pulls in stay
// resolvable outside the Next.js runtime, so `npm run check:payments` can
// exercise the real schemas the same way `check:classes` exercises
// classGroupSchema.
import { localeSchema } from "./auth.ts";
import { normalizeEmail } from "../identity.ts";
import { optionalPhone } from "./phone-schema.ts";
import { dateFilterSchema } from "./date-filter.ts";
import { MAX_PIASTRES, parseEgpToPiastres } from "../money.ts";
import {
  confirmConflictsField,
  extraRoomIdsField,
  type SlotConflictState,
} from "./room-set.ts";

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

const base = { locale: localeSchema };

/** Exactly three statuses (R1): present, late, absent. */
export const attendanceStatus = z.enum(["PRESENT", "LATE", "ABSENT"], {
  error: "invalidStatus",
});

/**
 * A check-in never carries a status (R2): the server decides PRESENT/LATE
 * from the clock (`lib/scheduling.ts`'s `checkInStatus`), so a client-sent
 * status — any value at all — is refused rather than silently ignored.
 */
const noClientStatus = z.never({ error: "invalidStatus" }).optional();

/**
 * A centre-configured method's id (R1). Shape only — whether it names an
 * *active* method of *this* centre is decided inside `recordPayment`'s
 * transaction, never here.
 */
const paymentMethodId = z.string().trim().min(1, "invalidMethod").max(64, "invalidMethod");

// ── Today's Sessions dashboard filters (M18: the shared date filter) ───────

/**
 * A filter dropdown's "All" option submits an **empty string**, not nothing —
 * so an optional enum has to read `""` as "no filter" rather than as an
 * invalid value. Without this the whole filter object failed to parse the
 * moment Status sat on "All" (its default), and the page's `safeParse`
 * fallback then discarded *every* filter alongside it — including a date
 * range the user had just picked, which is what made the Sessions tab snap
 * back to today.
 */
const optionalSessionStatus = z
  .preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(["SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"]).optional(),
  )
  .transform((value) => value ?? null);


export const sessionListFilterSchema = dateFilterSchema.extend({
  teacherId: optionalRef,
  subjectId: optionalRef,
  classGroupId: optionalRef,
  status: optionalSessionStatus,
});

// ── Attendance (check in / correct) ─────────────────────────────────────────

/** First mark on an enrolled roster row — a check-in, status decided server-side (R2). */
export const checkInRosterSchema = z.object({
  ...base,
  sessionId: recordId,
  studentProfileId: recordId,
  status: noClientStatus,
});

/**
 * A correction of an already-marked row, while the session is live (R2).
 * `reason` is optional; `confirmVoid` must be "true" when the change voids
 * the student's payment (PRESENT/LATE → ABSENT on a paid student) — the
 * roster's confirmation dialog sets it, so a void never happens unannounced.
 */
export const setAttendanceSchema = z.object({
  ...base,
  sessionId: recordId,
  studentProfileId: recordId,
  status: attendanceStatus,
  reason: z
    .string()
    .trim()
    .max(200, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  confirmVoid: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

// ── Add student to a session's roster ───────────────────────────────────────

/** An existing student found by search — enrolled or drop-in, decided server-side. */
export const addExistingAttendeeSchema = z.object({
  ...base,
  sessionId: recordId,
  studentProfileId: recordId,
  status: noClientStatus,
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
  status: noClientStatus,
  /** Present only after the duplicate-match panel has been confirmed. */
  linkUserId: optionalRef,
});

// ── Payment ──────────────────────────────────────────────────────────────

export const recordPaymentSchema = z.object({
  ...base,
  sessionAttendeeId: recordId,
  paymentMethodId,
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

/** "End session" (R2) — closes the session for good. */
export const endSessionSchema = z.object({
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

/**
 * A session's primary room (R3). Absent → `undefined` (reschedule: keep the
 * original's room set); empty → `null` (no room).
 */
const sessionRoomId = z
  .string()
  .trim()
  .max(64, "notFound")
  .optional()
  .transform((value) => (value === undefined ? undefined : value.length > 0 ? value : null));

export const rescheduleSessionSchema = z
  .object({
    ...base,
    sessionId: recordId,
    date: sessionDate,
    startTime: sessionTime,
    endTime: sessionTime,
    roomId: sessionRoomId,
    extraRoomIds: extraRoomIdsField,
    confirmConflicts: confirmConflictsField,
  })
  .refine((value) => value.startTime < value.endTime, {
    path: ["endTime"],
    message: "invalidTimeRange",
  });

/** A session's own room set (R3) — this session only, never its class. */
export const sessionRoomsSchema = z.object({
  ...base,
  sessionId: recordId,
  roomId: sessionRoomId.transform((value) => value ?? null),
  extraRoomIds: extraRoomIdsField,
  confirmConflicts: confirmConflictsField,
});

// ── New session: an extra session on a class, or a one-time one (R5) ──────

/** A manual session needs a primary room in both modes (R3 room set). */
const requiredSessionRoom = z.string().trim().min(1, "roomRequired").max(64, "notFound");

const newSessionSlotFields = {
  ...base,
  teacherId: z.string().trim().min(1, "teacherRequired").max(64, "notFound"),
  roomId: requiredSessionRoom,
  extraRoomIds: extraRoomIdsField,
  // Shape only: "today or later in the centre's timezone" needs the centre's
  // clock and is decided by the data layer (lib/db/class-sessions.ts), so a
  // direct call is refused exactly like the form.
  date: sessionDate,
  startTime: sessionTime,
  endTime: sessionTime,
  confirmConflicts: confirmConflictsField,
};

const timeOrder = <T extends { startTime: string; endTime: string }>(value: T) =>
  value.startTime < value.endTime;

/** "For a class" — price and cut are the class's, so neither is posted. */
export const newClassSessionSchema = z
  .object({
    ...newSessionSlotFields,
    mode: z.literal("class"),
    classGroupId: z.string().trim().min(1, "classRequired").max(64, "notFound"),
  })
  .refine(timeOrder, { path: ["endTime"], message: "invalidTimeRange" });

/**
 * "One-time session" — no class: its own title (≤ 80), optional catalog
 * subject/grade, price (EGP → piastres through lib/money.ts's parser) and
 * centre cut, resolved exactly like the class form's (a whole percent 0–100,
 * or a FIXED EGP amount the centre takes).
 */
export const newOneOffSessionSchema = z
  .object({
    ...newSessionSlotFields,
    mode: z.literal("oneOff"),
    title: z.string().trim().min(1, "titleRequired").max(80, "tooLong"),
    subjectId: optionalRef,
    gradeId: optionalRef,
    price: z.string().trim().min(1, "priceRequired"),
    centerShareType: z.enum(["FIXED", "PERCENTAGE"], { error: "invalidShareType" }),
    shareValue: z.string().trim().min(1, "required"),
  })
  .refine(timeOrder, { path: ["endTime"], message: "invalidTimeRange" })
  .transform((value, ctx) => {
    const price = parseEgpToPiastres(value.price);
    if (price === null) {
      ctx.addIssue({ code: "custom", path: ["price"], message: "invalidAmount" });
      return z.NEVER;
    }
    let centerShareValue: number;
    if (value.centerShareType === "PERCENTAGE") {
      const percent = Number(value.shareValue);
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
        ctx.addIssue({ code: "custom", path: ["shareValue"], message: "invalidPercent" });
        return z.NEVER;
      }
      centerShareValue = percent;
    } else {
      const piastres = parseEgpToPiastres(value.shareValue);
      if (piastres === null || piastres > MAX_PIASTRES) {
        ctx.addIssue({ code: "custom", path: ["shareValue"], message: "invalidAmount" });
        return z.NEVER;
      }
      centerShareValue = piastres;
    }
    return {
      locale: value.locale,
      mode: value.mode,
      title: value.title,
      subjectId: value.subjectId,
      gradeId: value.gradeId,
      teacherId: value.teacherId,
      roomId: value.roomId,
      extraRoomIds: value.extraRoomIds,
      date: value.date,
      startTime: value.startTime,
      endTime: value.endTime,
      price,
      centerShareType: value.centerShareType,
      centerShareValue,
      confirmConflicts: value.confirmConflicts,
    };
  });

/** Delete a pristine, future manual or one-time session (R5). */
export const deleteSessionSchema = z.object({
  ...base,
  sessionId: recordId,
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
  /** Decided server-side from the clock (R2) — a client-sent status is refused. */
  status: noClientStatus,
  /** No method = check in without recording a payment (spec §5 "No debt"). */
  paymentMethodId: optionalRef,
});

// ── Action state ────────────────────────────────────────────────────────────

/**
 * A person who already exists, surfaced before anything is linked — the same
 * shape `lib/db/identity.ts`'s `describeMatch` returns for the Students
 * screen (spec §5, never a silent merge).
 */
export type SessionMatchCandidate = {
  userId: string;
  /** Null when known only outside this organisation (SEC-11 / D-08 (b)). */
  name: string | null;
  email: string | null;
  phone: string | null;
  matchedOn: ("email" | "phone")[];
  existingHere: "student" | "teacher" | "staff" | null;
  existingProfileId?: string;
  linkable: boolean;
};

export type SessionActionState = SlotConflictState & {
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
    | "shareUpdated"
    | "roomsUpdated"
    | "closed";
  match?: SessionMatchCandidate;
  /** The replacement session a reschedule created (M15) — for a link to it. */
  newSessionId?: string;
  /** Reception check-in (R7): the status the server stored — decided from the clock (R2), never client-sent. */
  attendanceStatus?: "PRESENT" | "LATE" | "ABSENT";
  /** Reception check-in (R7): the roster row already existed, so no new attendance was written. */
  alreadyCheckedIn?: boolean;
};

export const IDLE_SESSION_STATE: SessionActionState = {};
