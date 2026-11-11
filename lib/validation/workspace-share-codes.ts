import { z } from "zod";

// Relative imports on purpose, like the other validation modules: the gates
// (`npm run check:workspaces`) parse through the real schemas.
import { localeSchema } from "./auth.ts";

/**
 * W10 (D-W43): workspace share codes. Inputs only — no schema carries a user
 * id: the teacher and the redeemer are always the session's. The teacher's
 * verbs post the workspace and the profile (`workspaceStudentRecordSchema`,
 * lib/validation/workspace-students.ts); the redeemer posts the code. The
 * code's shape is decided by the writer (`lib/workspace-share-code.ts`), so a
 * malformed one is refused there with the one generic answer. Messages are
 * i18n keys under `WorkspaceJoin.errors` / `WorkspaceStudents.errors`.
 */

/** The teacher's "Share code" / "Revoke code". `code` is set exactly once — on the answer that created it. */
export type WorkspaceShareCodeActionState = {
  error?: string;
  status?: "created" | "revoked";
  /** The plaintext code, 12 symbols, only on `created`. */
  code?: string;
  /** ISO instant the new code stops working, only on `created`. */
  expiresAt?: string;
};

export const IDLE_WORKSPACE_SHARE_CODE_STATE: WorkspaceShareCodeActionState = {};

/** The redeemer's side: a preview to confirm, then the link. */
export type WorkspaceJoinState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "preview" | "joined";
  preview?: { workspaceName: string; teacherName: string | null };
};

export const IDLE_WORKSPACE_JOIN_STATE: WorkspaceJoinState = {};

/** A code typed or carried in the join URL's fragment. Only its size here; the writer decides. */
export const workspaceShareCodeSchema = z.object({
  locale: localeSchema,
  code: z.string().trim().min(1, "required").max(40, "invalidCode"),
});
