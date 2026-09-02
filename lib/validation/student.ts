import { z } from "zod";

import { localeSchema } from "./auth";

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

export type StudentActionState = {
  error?: string;
  status?: "enrolled" | "pending" | "cancelled";
};

export const IDLE_STUDENT_STATE: StudentActionState = {};
