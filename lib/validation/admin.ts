import { z } from "zod";

// Relative imports on purpose — `npm run check:admin` exercises the real
// schemas outside the Next.js runtime (same reasoning as
// lib/validation/settings.ts).
import { localeSchema } from "./auth.ts";

/**
 * Platform-admin schemas (M9). Messages are i18n keys under
 * `AdminCenters.errors`, never user-facing copy (docs/02 §7).
 */

const checkbox = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "true");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null));

const centerName = z.string().trim().min(1, "required").max(120, "tooLong");

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "invalidSlug")
  .max(60, "invalidSlug")
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "invalidSlug");

const themeColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "invalidColor");

const ownerEmail = z
  .string()
  .trim()
  .min(1, "required")
  .max(254, "tooLong")
  .email("invalidEmail")
  .transform((value) => value.toLowerCase());

/** Center ids are always `@default(uuid())` (unlike the seeded main branch). */
const centerId = z.string().uuid("notFound");

export const createCenterSchema = z.object({
  locale: localeSchema,
  name: centerName,
  nameEn: optionalText(120),
  slug,
  logoUrl: optionalText(500),
  themeColor,
  plan: optionalText(60),
  ownerEmail,
});

export const centerIdSchema = z.object({
  locale: localeSchema,
  id: centerId,
});

export const centerActiveSchema = z.object({
  locale: localeSchema,
  id: centerId,
  active: checkbox,
});

/** M13's admin review queue — CatalogSuggestion ids are also `@default(uuid())`. */
export const catalogSuggestionIdSchema = z.object({
  locale: localeSchema,
  id: z.string().uuid("notFound"),
});

export const centerPlanSchema = z.object({
  locale: localeSchema,
  id: centerId,
  plan: optionalText(60),
});
