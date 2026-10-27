import { z } from "zod";

// Relative imports on purpose (matches lib/validation/auth.ts): the gates
// parse with the real schemas outside the Next.js runtime.
import { email, localeSchema, password, personName } from "./auth.ts";
import { optionalPhone } from "./phone-schema.ts";

/**
 * Account settings (F2). Message keys resolve under `Account.errors`, which
 * carries every `Auth.errors` key these shared fields can produce.
 */
export const accountProfileSchema = z.object({
  firstName: personName,
  lastName: personName,
  // Normalized through lib/phone.ts — the one normalizer (rule 10).
  contactPhone: optionalPhone,
  preferredLocale: localeSchema,
  locale: localeSchema,
});

const currentPassword = z.string().min(1, "required").max(72, "tooLong");

export const changePasswordSchema = z
  .object({
    currentPassword,
    newPassword: password,
    confirmPassword: z.string().max(72, "tooLong"),
    // Ticked by default on the form; posted as "true"/"false".
    signOutOthers: z
      .string()
      .optional()
      .transform((value) => value === "on" || value === "true"),
    locale: localeSchema,
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "passwordMismatch",
  });

export const changeEmailSchema = z.object({
  newEmail: email,
  currentPassword,
  locale: localeSchema,
});

/**
 * Account → Study details and onboarding's "Your studies" (F4): the student's
 * own grade — a platform catalog grade id, or empty to clear it. Resolved
 * against the catalog server-side (`lib/db/account-study.ts`).
 */
export const studyDetailsSchema = z.object({
  locale: localeSchema,
  gradeId: z
    .string()
    .trim()
    .max(64, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

/**
 * The study-details form state (F4). Lives here, not in `study-actions.ts`: a
 * `"use server"` file may export only async functions, so a constant exported
 * from it breaks the server-actions manifest. `error` and the `fieldErrors`
 * values are keys under `Account.errors`.
 */
export type StudyDetailsState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "saved";
};

export const IDLE_STUDY_STATE: StudyDetailsState = {};
