import { z } from "zod";

// Relative imports on purpose, like the other validation modules, so the
// gates parse through the real schemas outside the Next.js runtime.
import { classPeriodError, dayMarker } from "../scheduling.ts";

/**
 * The R4 period fields — a class's `startDate`/`endDate` and a term's — as
 * the forms post them: "YYYY-MM-DD" from the shared `DatePicker`, parsed to
 * the UTC-midnight day marker `Session.date`/`Holiday.date` use. Messages
 * are i18n keys (`Classes.errors` / `Settings.errors`).
 */

/** A required "YYYY-MM-DD" → its UTC-midnight day marker. */
export const dateOnlyField = z
  .string({ error: "required" })
  .trim()
  .min(1, "required")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "invalidDate")
  .refine((value) => {
    const parsed = dayMarker(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "invalidDate")
  .transform((value) => dayMarker(value));

/**
 * Adds `lib/scheduling.ts`'s `classPeriodError` to an object schema that has
 * `startDate`/`endDate` — the one period rule (end on or after start, at most
 * `MAX_CLASS_PERIOD_DAYS`), reported on `endDate`.
 */
export function withPeriodRule<T extends { startDate: Date; endDate: Date }>(
  value: T,
  ctx: z.RefinementCtx,
): void {
  // A date that already failed its own field rule reaches here unparsed —
  // that field's error is the one to show.
  if (!(value.startDate instanceof Date) || !(value.endDate instanceof Date)) return;
  const error = classPeriodError(value.startDate, value.endDate);
  if (error) ctx.addIssue({ code: "custom", path: ["endDate"], message: error });
}
