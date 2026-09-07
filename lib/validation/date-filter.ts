import { z } from "zod";

/**
 * The shared date-filter's URL shape (M18, docs/04-design-system.md §11.7):
 * `range` picks the mode, `date` is the anchor for a specific day, `from`/`to`
 * bound a custom range. Every screen that filters by date (Analytics,
 * Expenses, Sessions, …) parses through this one schema — CLAUDE.md rule 10's
 * "one normalizer per rule" applied to date filtering, not just phone
 * numbers.
 */
export const dateFilterKindSchema = z.enum(["day", "week", "month", "date", "range"]);

const isoDate = z
  .string()
  .trim()
  .max(10)
  .optional()
  .transform((value) =>
    value && !Number.isNaN(Date.parse(value)) ? value.slice(0, 10) : null,
  );

export const dateFilterSchema = z.object({
  range: dateFilterKindSchema.default("day"),
  date: isoDate,
  from: isoDate,
  to: isoDate,
});

export type DateFilterInput = z.infer<typeof dateFilterSchema>;

/** `dateFilterSchema`'s output, turned into the `Date | null` triple
 * `resolveSharedDateFilter` (lib/scheduling.ts) actually consumes. */
export function toSharedDateFilterInput(filter: DateFilterInput): {
  kind: DateFilterInput["range"];
  date: Date | null;
  from: Date | null;
  to: Date | null;
} {
  const toDate = (value: string | null) =>
    value ? new Date(`${value}T00:00:00.000Z`) : null;
  return {
    kind: filter.range,
    date: toDate(filter.date),
    from: toDate(filter.from),
    to: toDate(filter.to),
  };
}
