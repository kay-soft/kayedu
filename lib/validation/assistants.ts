import { z } from "zod";

// Relative imports on purpose (matches lib/validation/parents.ts): the gates
// parse with the real schemas outside the Next.js runtime.
import { localeSchema } from "./auth.ts";
import type { AssistantPermission, AssistantPresetName } from "../assistant-catalog.ts";

/**
 * Assistants (W7a, D-W36). Inputs only — the acting user always comes from
 * the session, never the form; a posted invite or link id is only ever looked
 * up together with that user (`lib/db/assistants.ts`). The catalogue and the
 * presets are checked by the writer, not here, so an unknown name reaches it
 * and is refused there with nothing written. Message keys resolve under
 * `Assistants.errors`.
 */

const recordId = z.string().trim().min(1).max(64);

/** Every teacher-side action's result. `code` is set exactly once — on the answer that created it. */
export type TeacherAssistantActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "created" | "revoked" | "saved" | "unchanged" | "removed";
  /** The plaintext code, 12 symbols, only on `created`. */
  code?: string;
  /** ISO instant the new code stops working, only on `created`. */
  expiresAt?: string;
};

export const IDLE_TEACHER_ASSISTANT_STATE: TeacherAssistantActionState = {};

/** The redeemer's side: a preview to confirm, then the link. */
export type AssistantJoinState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "preview" | "joined" | "left";
  preview?: { teacherName: string; preset: AssistantPresetName; permissions: AssistantPermission[] };
  /** Where the new assistant experience lives, on `joined`. */
  teacherUserId?: string;
};

export const IDLE_ASSISTANT_JOIN_STATE: AssistantJoinState = {};

/** Teacher → Invite an assistant. */
export const createAssistantInviteSchema = z.object({
  locale: localeSchema,
  preset: z.string().trim().min(1, "required").max(32, "unknownPreset"),
});

/** Teacher → Revoke a pending invite. */
export const revokeAssistantInviteSchema = z.object({
  locale: localeSchema,
  inviteId: recordId,
});

/** Teacher → Remove an assistant; the assistant → Leave. */
export const assistantLinkSchema = z.object({
  locale: localeSchema,
  linkId: recordId,
});

/**
 * Teacher → change permissions: either a preset (`mode=preset`) or the whole
 * set of toggles (`mode=toggles`, every checked `permission` field).
 */
export const assistantPermissionsSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("preset"), locale: localeSchema, linkId: recordId, preset: z.string().trim().min(1).max(32) }),
  z.object({
    mode: z.literal("toggles"),
    locale: localeSchema,
    linkId: recordId,
    permissions: z.array(z.string().trim().min(1).max(64)).max(64),
  }),
]);

/** A code typed or carried in the join URL's fragment. Only its shape here; the writer decides. */
export const assistantCodeSchema = z.object({
  locale: localeSchema,
  code: z.string().trim().min(1, "required").max(40, "invalidCode"),
});
