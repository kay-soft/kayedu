import { z } from "zod";

import { localeSchema } from "./auth";
import { studentFields } from "./people";

/**
 * Student portal schemas (M8). Every Server Action under
 * `app/[locale]/(student)/student/**\/actions.ts` parses its input through
 * one of these before touching the database (docs/02 §7).
 *
 * `centerId` is a real field here — unlike every other experience's actions,
 * a student-facing write has no single "active center" from `getTenantContext`
 * to fall back on (Discover is cross-center by design). It is never trusted
 * on its own: every write re-derives the truth from the database
 * (`scopedWhere(centerId, { id: classGroupId })` — an id that does not
 * actually belong to that center resolves to nothing, `lib/db/reservations.ts`).
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

export const reserveClassSchema = z.object({
  locale: localeSchema,
  centerId: recordId,
  classGroupId: recordId,
});

export const cancelReservationSchema = z.object({
  locale: localeSchema,
  centerId: recordId,
  reservationId: recordId,
});

/**
 * U8 — "Leave class". Names the class, never an enrolment: the action finds
 * the caller's own ACTIVE enrolment in it, so there is no id to guess.
 */
export const leaveClassSchema = z.object({
  locale: localeSchema,
  centerId: recordId,
  classGroupId: recordId,
});

/** F6 — "Attend this session only": one session, at one branch. */
export const bookSessionSchema = z.object({
  locale: localeSchema,
  centerId: recordId,
  sessionId: recordId,
});

/** F6 — a student withdrawing their own booking. */
export const cancelBookingSchema = z.object({
  locale: localeSchema,
  centerId: recordId,
  bookingId: recordId,
});

// ── Self-registration profile completion (M18, spec §4.3 item 4) ──────────
// The exact same fields a receptionist's add-student form collects — grade,
// phone, alt phone, parent name/phone/alt phone — filled in by the student
// themselves the first time they reach the portal with an auto-seeded,
// incomplete profile (`StudentProfile.profileCompletedAt === null`).

export const completeStudentProfileSchema = z.object({
  locale: localeSchema,
  centerId: recordId,
  studentProfileId: recordId,
  ...studentFields,
});

export type StudentActionState = {
  error?: string;
  /** Formatted date for the `coolingOff` (M15) and `sessionFull` (F6) error messages. */
  errorDate?: string;
  /** `booked` / `bookingPending` — F6's two booking outcomes. */
  status?: "enrolled" | "pending" | "cancelled" | "profileCompleted" | "booked" | "bookingPending" | "left";
  fieldErrors?: Record<string, string>;
};

export const IDLE_STUDENT_STATE: StudentActionState = {};
