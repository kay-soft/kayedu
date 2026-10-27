import { z } from "zod";

// Relative imports on purpose (matches lib/validation/account.ts): the gates
// parse with the real schemas outside the Next.js runtime.
import { localeSchema, personName } from "./auth.ts";
import { normalizePhone } from "../phone.ts";

/**
 * Family links (F3). Inputs only — who is acting always comes from the
 * session (a student, a parent, or branch staff resolved by
 * `getTenantContext`), never from the form. Message keys resolve under
 * `Family.errors`.
 */

const recordId = z.string().trim().min(1).max(64);

/**
 * Every family action's result. `code` is set exactly once — on the answer
 * to the request that created it — and is never stored or sent again.
 */
export type FamilyActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "issued" | "saved" | "linked" | "revoked";
  /** The plaintext code, 8 symbols, only on `issued`. */
  code?: string;
};

export const IDLE_FAMILY_STATE: FamilyActionState = {};

/** A required parent phone, normalized through lib/phone.ts (rule 10). Never an identity key. */
const declaredPhone = z
  .string()
  .trim()
  .max(20, "tooLong")
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!value) {
      ctx.addIssue({ code: "custom", message: "required" });
      return z.NEVER;
    }
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "invalidPhone" });
      return z.NEVER;
    }
    return normalized;
  });

/** Account → Family → Invite a parent. */
export const inviteParentSchema = z.object({
  locale: localeSchema,
  parentFirstName: personName,
  parentLastName: personName,
  parentPhone: declaredPhone,
});

/** A student's own pending invitation: New code / Cancel. */
export const studentInvitationSchema = z.object({
  locale: localeSchema,
  invitationId: recordId,
});

/**
 * A code typed or carried in the join URL's fragment. Only its shape is
 * checked here; `normalizeFamilyCode` (lib/db/parents.ts) decides.
 */
export const acceptFamilyCodeSchema = z.object({
  locale: localeSchema,
  code: z.string().trim().min(1, "required").max(32, "invalidCode"),
});

/** The parent unlinks a child (Account → Family). */
export const unlinkChildSchema = z.object({
  locale: localeSchema,
  linkId: recordId,
});

/** Branch staff: Generate / Cancel a parent code for one student. */
export const branchCodeSchema = z.object({
  locale: localeSchema,
  studentProfileId: recordId,
});

/** Branch staff: Remove a parent's access, with a reason (on the record, never in the audit row). */
export const branchRevokeLinkSchema = z.object({
  locale: localeSchema,
  studentProfileId: recordId,
  linkId: recordId,
  reason: z.string().trim().min(1, "reasonRequired").max(500, "tooLong"),
});
