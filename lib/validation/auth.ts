import { z } from "zod";

import { optionalPhone } from "./phone-schema.ts";

export const localeSchema = z.enum(["ar", "en"]);

const email = z
  .string()
  .trim()
  .min(1, "required")
  .max(254, "tooLong")
  .email("invalidEmail")
  .transform((value) => value.toLowerCase());

const password = z.string().min(8, "passwordTooShort").max(72, "tooLong");

const personName = z.string().trim().min(1, "required").max(60, "tooLong");

export const signInSchema = z.object({
  email,
  password: z.string().min(1, "required"),
  locale: localeSchema,
  next: z.string().optional(),
});

export const signUpSchema = z
  .object({
    firstName: personName,
    lastName: personName,
    email,
    phone: optionalPhone,
    password,
    confirmPassword: z.string(),
    locale: localeSchema,
    next: z.string().optional(),
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
});

export const invitationIdSchema = z.object({
  invitationId: z.string().uuid("invalidInvitation"),
  locale: localeSchema,
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(16, "invalidToken").max(128, "invalidToken"),
  locale: localeSchema,
});

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
