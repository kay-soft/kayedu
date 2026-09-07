import { z } from "zod";

import { localeSchema } from "./auth.ts";

/**
 * The `/settlements` screen's schemas (M14, docs/00-master-product-spec.md
 * §4.1 item 11). Two creation shapes, matching the two scopes a Settlement
 * supports (`lib/db/settlements.ts`): a single session's teacher share, or a
 * date-range roll-up for one teacher. Approve/pay share one shape — which
 * row, resolved server-side to `ctx.center.id`/`ctx.user.id`, never a
 * client-sent center or actor (the same pattern `lib/validation/approvals.ts`
 * uses).
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

export const createSessionSettlementSchema = z.object({
  locale: localeSchema,
  sessionId: recordId,
});

const isoDate = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), "invalidDate")
  .transform((value) => new Date(`${value.slice(0, 10)}T00:00:00.000Z`));

export const createPeriodSettlementSchema = z.object({
  locale: localeSchema,
  teacherId: recordId,
  from: isoDate,
  to: isoDate,
});

export const settlementIdSchema = z.object({
  locale: localeSchema,
  id: recordId,
});

export type SettlementActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "created" | "approved" | "paid";
};

export const IDLE_SETTLEMENT_STATE: SettlementActionState = {};
