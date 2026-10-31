import { z } from "zod";

// Relative import on purpose (matches lib/validation/people.ts and
// lib/validation/sessions.ts): this module stays resolvable outside the
// Next.js runtime, so the gate scripts can exercise the real schema.
import { normalizePhone } from "../phone.ts";

/**
 * The one zod phone schema every form-parsing schema in the app shares (M18,
 * CLAUDE.md rule 10). It used to be copy-pasted, byte-for-byte, into
 * lib/validation/people.ts and lib/validation/sessions.ts — a second
 * implementation of the same rule is exactly what this file exists to stop.
 *
 * Normalizes to the stored E.164 form `+20XXXXXXXXXX` (U4) so the duplicate
 * match cannot be dodged by typing `+20…`, `0…` or Arabic digits instead
 * (spec §5).
 */
export const optionalPhone = z
  .string()
  .trim()
  .max(20, "tooLong")
  .optional()
  .transform((value, ctx) => {
    if (!value || value.length === 0) return null;
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "invalidPhone" });
      return z.NEVER;
    }
    return normalized;
  });

