import { z } from "zod";

// Relative imports on purpose, like the other validation modules: the gates
// (`npm run check:workspaces`) parse through the real schemas.
import { localeSchema } from "./auth.ts";
import { optionalPhone } from "./phone-schema.ts";

/**
 * W8b (D-W39) form schemas: adding a workspace student, copying one from
 * another workspace, the invitation verbs and enrolment. Messages are i18n
 * keys under `WorkspaceStudents.errors` (then `Workspaces.errors`). No schema
 * carries a user id: the actor is always the session's (`check:workspaces`).
 */

const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

/** A name part — the same 60 as `WORKSPACE_STUDENT_NAME_MAX` (lib/db/workspace-students.ts). */
export const WORKSPACE_STUDENT_NAME_MAX_LENGTH = 60;

const namePart = z.string().trim().min(1, "nameRequired").max(WORKSPACE_STUDENT_NAME_MAX_LENGTH, "tooLong");

/** Required here: a workspace student is added by phone (D-W27). */
const requiredPhone = optionalPhone.refine((value): value is string => value !== null, "phoneRequired");

const optionalGrade = z
  .string()
  .trim()
  .max(64, "notFound")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

const base = { locale: localeSchema, workspaceId: recordId };

export const workspaceStudentAddSchema = z.object({
  ...base,
  firstName: namePart,
  lastName: namePart,
  phone: requiredPhone,
  gradeId: optionalGrade,
});

export const workspaceStudentCopySchema = z.object({
  ...base,
  /** "<sourceWorkspaceId>:<studentProfileId>", the picker's one value. */
  source: z
    .string()
    .trim()
    .max(140, "notFound")
    .transform((value, ctx) => {
      const [sourceWorkspaceId, studentProfileId, extra] = value.split(":");
      if (!sourceWorkspaceId || !studentProfileId || extra !== undefined) {
        ctx.addIssue({ code: "custom", message: "pickStudent" });
        return z.NEVER;
      }
      return { workspaceId: sourceWorkspaceId, studentProfileId };
    }),
});

export const workspaceStudentRecordSchema = z.object({ ...base, studentProfileId: recordId });

export const workspaceEnrollSchema = z.object({ ...base, classId: recordId, studentProfileId: z.string().trim().min(1, "pickStudent").max(64, "notFound") });

export const workspaceEnrollmentRecordSchema = z.object({ ...base, classId: recordId, enrollmentId: recordId });

export const workspaceInvitationResponseSchema = z.object({ locale: localeSchema, invitationId: recordId });

/** What every W8b action returns: `error` / `fieldErrors` values are i18n keys. */
export type WorkspaceStudentActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "added" | "invited" | "cancelled" | "enrolled" | "removed" | "accepted" | "declined";
};

export const IDLE_WORKSPACE_STUDENT_STATE: WorkspaceStudentActionState = {};
