import { z } from "zod";

// Relative imports on purpose, like the other validation modules: the gates
// (`npm run check:workspaces`) parse through the real schemas.
import { localeSchema } from "./auth.ts";

/**
 * W8c (D-W40) form schemas: check-in, a correction, recording, voiding and
 * refunding a payment, and closing a session, in a PERSONAL workspace.
 * Messages are i18n keys under `WorkspaceSession.errors`. **No schema carries
 * a user id, an amount or a payment method**: the actor is the session's, the
 * amount is the session's frozen price (`recordPayment`) and the method is the
 * workspace's hidden Cash, both resolved on the server (`check:workspaces`).
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

/** The reason a void or refund needs (the same 200 as a branch's, `lib/validation/sessions.ts`). */
const requiredReason = z.string().trim().min(1, "required").max(200, "tooLong");

const base = { locale: localeSchema, workspaceId: recordId, sessionId: recordId };

export const workspaceCheckInSchema = z.object({ ...base, studentProfileId: recordId });

/**
 * A correction on a checked-in row. `confirmVoid` is "true" from the Absent
 * dialog of a paid student, and then a reason is required — the server
 * re-checks against the payment it finds (D-13), and the engine once more.
 */
export const workspaceSetAttendanceSchema = z
  .object({
    ...base,
    studentProfileId: recordId,
    status: z.enum(["PRESENT", "LATE", "ABSENT"], { message: "notFound" }),
    reason: z
      .string()
      .trim()
      .max(200, "tooLong")
      .optional()
      .transform((value) => (value && value.length > 0 ? value : null)),
    confirmVoid: z
      .string()
      .optional()
      .transform((value) => value === "true"),
  })
  .superRefine((value, ctx) => {
    if (value.confirmVoid && !value.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reasonRequired" });
    }
  });

export const workspaceRecordPaymentSchema = z.object({ ...base, attendeeId: recordId });

export const workspaceReversalSchema = z.object({ ...base, paymentId: recordId, reason: requiredReason });

export const workspaceCloseSessionSchema = z.object(base);

/** What every W8c action returns: `error` / `fieldErrors` values are i18n keys. */
export type WorkspaceSessionActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "checkedIn" | "saved" | "paid" | "voided" | "refunded" | "closed";
};

export const IDLE_WORKSPACE_SESSION_STATE: WorkspaceSessionActionState = {};
