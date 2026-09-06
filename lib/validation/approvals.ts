import { z } from "zod";

import { localeSchema } from "./auth";

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

export type ApprovalsActionState = {
  error?: string;
  status?: "approved" | "declined";
};

export const IDLE_APPROVALS_STATE: ApprovalsActionState = {};
