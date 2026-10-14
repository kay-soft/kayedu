import { z } from "zod";

// Relative imports on purpose, matching lib/validation/sessions.ts and
// lib/validation/settings.ts: this module stays resolvable outside the
// Next.js runtime so `npm run check:analytics` can exercise the real schemas.
import { localeSchema } from "./auth.ts";
import { dateFilterSchema } from "./date-filter.ts";
import { dateOnlyField } from "./class-period.ts";
import { MAX_PIASTRES, parseEgpToPiastres } from "../money.ts";

/**
 * Analytics & Expenses schemas (M6). Every Server Action parses its input
 * through one of these before touching the database (docs/02 §7).
 *
 * Messages are **i18n keys** — `Analytics.errors` / `Expenses.errors` — never
 * user-facing copy.
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

const optionalRef = z
  .string()
  .trim()
  .max(64, "notFound")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

const entityName = z.string().trim().min(1, "required").max(80, "tooLong");

const checkbox = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "true");

const base = { locale: localeSchema };

// ── Date filters (Analytics + Expenses share the shared date filter, M18) ──

/** Analytics adds one dimension (teacher) on top of the shared date filter. */
export const analyticsFilterSchema = dateFilterSchema.extend({
  teacherId: optionalRef,
});

/** Expenses reuse the exact same date filter, with no teacher dimension. */
export const expenseFilterSchema = dateFilterSchema;

// ── Expense categories (master data — same shape as lib/validation/settings.ts) ─

export const expenseCategorySchema = z.object({ ...base, name: entityName });
export const expenseCategoryUpdateSchema = expenseCategorySchema.extend({ id: recordId });
export const expenseCategoryToggleSchema = z.object({
  ...base,
  id: recordId,
  active: checkbox,
});
export const expenseCategoryDeleteSchema = z.object({ ...base, id: recordId });

// ── Expenses (append, void with a reason, audit — D-24) ─────────────────────

export const expenseCreateSchema = z.object({
  ...base,
  categoryId: optionalRef,
  amount: z
    .string()
    .trim()
    .min(1, "required")
    .transform((value, ctx) => {
      const piastres = parseEgpToPiastres(value);
      if (piastres === null || piastres > MAX_PIASTRES || piastres <= 0) {
        ctx.addIssue({ code: "custom", message: "invalidAmount" });
        return z.NEVER;
      }
      return piastres;
    }),
  // SEC-50: a strict calendar day. "Not in the future and not older than the
  // centre's visibility window" (D-24) needs the centre's clock, so the
  // action checks it (lib/db/expenses.ts's `expenseDateError`).
  date: dateOnlyField,
  note: z
    .string()
    .trim()
    .max(200, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

/** D-24: an expense is voided with a reason, never deleted. */
export const expenseVoidSchema = z.object({
  ...base,
  id: recordId,
  reason: z.string().trim().min(1, "required").max(200, "tooLong"),
});
