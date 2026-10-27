import { z } from "zod";

import { localeSchema } from "./auth";
import { confirmConflictsField, type SlotConflictState } from "./room-set";

/**
 * The Approvals screen's schemas (M6/M7/M8 gap, closed at this milestone —
 * docs/00-master-product-spec.md §4.1 item 9). Both `ChangeRequest` and
 * `Reservation` decisions share the same shape: which row, resolved server-
 * side to `ctx.center.id`/`ctx.user.id` — the id alone, never a client-sent
 * center or actor.
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

export const approvalIdSchema = z.object({
  locale: localeSchema,
  id: recordId,
});

/** Accepting a NEW_SESSION request (R3: may need a double-booking confirmed). */
export const approveSessionRequestSchema = approvalIdSchema.extend({
  confirmConflicts: confirmConflictsField,
});

export type ApprovalsActionState = SlotConflictState & {
  error?: string;
  /** F6 — a formatted date for `error` ("sessionFull": the first full session). */
  errorDate?: string;
  /** `cancelled` — a staff cancel of a confirmed booking (T7). */
  status?: "approved" | "declined" | "cancelled";
};

export const IDLE_APPROVALS_STATE: ApprovalsActionState = {};
