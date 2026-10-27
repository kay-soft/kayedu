import { z } from "zod";

export const localeSchema = z.enum(["ar", "en"]);

export const email = z
  .string()
  .trim()
  .min(1, "required")
  .max(254, "tooLong")
  .email("invalidEmail")
  .transform((value) => value.toLowerCase());

/** The password policy — sign-up and Account settings share it. */
export const password = z.string().min(8, "passwordTooShort").max(72, "tooLong");

export const personName = z.string().trim().min(1, "required").max(60, "tooLong");

export const signInSchema = z.object({
  email,
  // Bounded like every other input (SEC-74): bcrypt reads 72 bytes anyway.
  password: z.string().min(1, "required").max(72, "tooLong"),
  locale: localeSchema,
  next: z.string().max(512).optional(),
});

/** "Send the confirmation email again" (SEC-2a). */
export const resendConfirmationSchema = z.object({
  email,
  locale: localeSchema,
});

/** F4: who the person says they are joining as — required, three values. */
export const signupIntentSchema = z.enum(["STUDENT", "PARENT", "TEACHER"], {
  error: "intentRequired",
});

export const signUpSchema = z
  .object({
    signupIntent: signupIntentSchema,
    firstName: personName,
    lastName: personName,
    email,
    password,
    confirmPassword: z.string().max(72, "tooLong"),
    locale: localeSchema,
    next: z.string().max(512).optional(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "passwordMismatch",
  });

/**
 * A Center id for almost every submission — or, for an Owner picking "Whole
 * Management" (M11), an Organization id. One field, one cookie value; which
 * one it names is resolved server-side in `selectCenterAction`/
 * `getTenantContext()`, never trusted from the client beyond that lookup
 * (lib/auth/active-center.ts).
 */
export const selectCenterSchema = z.object({
  selectionId: z.string().uuid("invalidCenter"),
  locale: localeSchema,
  /**
   * T6: the page a branch was picked from (the pick-a-branch screen), so the
   * pick lands back there. Untrusted — only ever read through `safeNextPath`.
   */
  next: z.string().max(512).optional(),
});

/**
 * The roles Users & Roles may hand out (R9): centre staff only. A TEACHER is a
 * `Membership` too, but teachers are added and managed on the Teachers page —
 * so this list, which both the invitation and the role-change schemas parse
 * with, refuses it by direct call exactly as the dropdowns no longer offer it.
 * Same four values as `CENTER_STAFF_ROLES` (lib/auth/permissions.ts).
 */
export const ASSIGNABLE_STAFF_ROLES = [
  "OWNER",
  "MANAGER",
  "RECEPTIONIST",
  "ACCOUNTANT",
] as const;

export const staffRoleField = z.enum(ASSIGNABLE_STAFF_ROLES, {
  error: (issue) =>
    issue.input === "TEACHER" ? "teacherViaTeachersPage" : "notFound",
});

export const createInvitationSchema = z.object({
  email,
  role: staffRoleField,
  locale: localeSchema,
  /**
   * F1: the branch to invite into; absent = the active branch. Only an id —
   * the action re-resolves the actor's context there and checks the
   * permission at that branch (`getTenantContextForBranch`).
   */
  branchId: z
    .string()
    .trim()
    .max(64, "invalidCenter")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const invitationIdSchema = z.object({
  invitationId: z.string().uuid("invalidInvitation"),
  locale: localeSchema,
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(16, "invalidToken").max(128, "invalidToken"),
  locale: localeSchema,
});

