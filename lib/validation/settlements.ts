import { z } from "zod";

import { localeSchema } from "./auth.ts";
import { dateOnlyField } from "./class-period.ts";
import { addDays } from "../scheduling.ts";

/**
 * The `/settlements` screen's schemas (M14, docs/00-master-product-spec.md
 * §4.1 item 11). Two creation shapes, matching the two scopes a Settlement
 * supports (`lib/db/settlements.ts`): a single session's teacher share, or a
 * date-range roll-up for one teacher. Approve/pay/cancel share one shape —
 * which row, resolved server-side to `ctx.center.id`/`ctx.user.id`, never a
 * client-sent center or actor (the same pattern `lib/validation/approvals.ts`
 * uses).
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

/**
 * The longest period one settlement may cover (SEC-2b, D-16 (c), SEC-23): a
 * year and a day, so a whole-year payout fits and a typo like 2026 → 9999
 * cannot sweep every future payment into one row. lib/db/settlements.ts
 * re-checks it by direct call.
 */
export const MAX_SETTLEMENT_PERIOD_DAYS = 366;

export const createSessionSettlementSchema = z.object({
  locale: localeSchema,
  sessionId: recordId,
});

/**
 * A period: strict calendar days (SEC-50), `from` on or before `to`, at most a
 * year and a day (SEC-23, D-16). "`to` not in the future" needs the centre's
 * clock and is the data layer's (`settlementRangeError`), by direct call too.
 */
export const createPeriodSettlementSchema = z
  .object({
    locale: localeSchema,
    teacherId: recordId,
    from: dateOnlyField,
    to: dateOnlyField,
  })
  .superRefine((value, ctx) => {
    if (!(value.from instanceof Date) || !(value.to instanceof Date)) return;
    if (value.from > value.to) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "invalidRange" });
    } else if (addDays(value.from, MAX_SETTLEMENT_PERIOD_DAYS) <= value.to) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "rangeTooLong" });
    }
  });

export const settlementIdSchema = z.object({
  locale: localeSchema,
  id: recordId,
});

export type SettlementActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "created" | "approved" | "paid" | "cancelled";
};

export const IDLE_SETTLEMENT_STATE: SettlementActionState = {};
