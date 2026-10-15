import { z } from "zod";

import type { SlotConflictInfo } from "../scheduling.ts";

/**
 * The form fields every R3 slot/room-set write shares (docs/02 §11
 * "confirmConflicts"). Relative imports only, like the other validation
 * modules, so the gates can parse through the real schemas.
 */

/**
 * The extra rooms combined with a primary room, posted as one hidden input
 * of comma-separated ids (`FormData` → `Object.fromEntries` keeps only the
 * last value of a repeated key, so a list travels as one value). Empty →
 * no extras. Whether each extra is linked to the primary is decided
 * server-side by `lib/db/room-sets.ts`'s `resolveRoomSet`, never here.
 */
export const extraRoomIdsField = z
  .string()
  .trim()
  .max(2_000, "notFound")
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  )
  .refine((ids) => ids.length <= 20 && ids.every((id) => id.length <= 64), "notFound");

/**
 * "I understand, create anyway" — the explicit confirmation a WARN
 * double-booking needs. Absent/unticked = `false`: every Server Action
 * passes this to the data layer explicitly, so a direct action call without
 * it is refused with the conflict list.
 */
export const confirmConflictsField = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "true");

/** What a refused/flagged slot write hands back to the form. */
export type SlotConflictState = {
  conflicts?: SlotConflictInfo[];
  /** The centre's policy when the list was produced — DENY shows no override. */
  conflictPolicy?: "WARN" | "DENY";
};
