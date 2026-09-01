import { z } from "zod";

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

// Egyptian mobile numbers, optionally +20 / 0020 prefixed.
const phone = z
  .string()
  .trim()
  .regex(/^(\+?20|0)?1[0125]\d{8}$/, "invalidPhone");

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
    phone: z.union([phone, z.literal("")]).optional(),
    password,
    confirmPassword: z.string(),
    locale: localeSchema,
    next: z.string().optional(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "passwordMismatch",
  });

export const selectCenterSchema = z.object({
  centerId: z.string().uuid("invalidCenter"),
  locale: localeSchema,
});

export const createInvitationSchema = z.object({
  email,
  role: z.enum(["OWNER", "MANAGER", "RECEPTIONIST", "TEACHER"]),
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
