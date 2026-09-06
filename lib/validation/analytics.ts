import { z } from "zod";

// Relative imports on purpose, matching lib/validation/sessions.ts and
// lib/validation/settings.ts: this module stays resolvable outside the
// Next.js runtime so `npm run check:analytics` can exercise the real schemas.
import { localeSchema } from "./auth.ts";
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

// ── Date-range filters (Analytics + Expenses share the same shape) ─────────

export const analyticsRangeSchema = z.enum(["day", "week", "month", "year", "all"]);

export const analyticsFilterSchema = z.object({
  range: analyticsRangeSchema.default("month"),
  /** Anchor date, "YYYY-MM-DD" — absent means today. Ignored when range="all". */
  date: z
    .string()
    .trim()
    .max(10)
    .optional()
    .transform((value) =>
      value && !Number.isNaN(Date.parse(value)) ? value.slice(0, 10) : null,
    ),
  teacherId: optionalRef,
});

/** Expenses reuse the exact same date filter, with no teacher dimension. */
export const expenseFilterSchema = analyticsFilterSchema.omit({ teacherId: true });

// ── Expense categories (master data — same shape as lib/validation/settings.ts) ─

export const expenseCategorySchema = z.object({ ...base, name: entityName });
export const expenseCategoryUpdateSchema = expenseCategorySchema.extend({ id: recordId });
export const expenseCategoryToggleSchema = z.object({
  ...base,
  id: recordId,
  active: checkbox,
});
export const expenseCategoryDeleteSchema = z.object({ ...base, id: recordId });

// ── Expenses (append-and-audit — see docs/01 §3 note on Expense in CLAUDE.md) ─

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
  date: z
    .string()
    .trim()
    .min(1, "required")
    .refine((value) => !Number.isNaN(Date.parse(value)), "invalidDate"),
  note: z
    .string()
    .trim()
    .max(200, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const expenseDeleteSchema = z.object({ ...base, id: recordId });
