import { z } from "zod";

// Relative imports on purpose — `npm run check:branches` exercises the real
// schema outside the Next.js runtime (same reasoning as ./admin.ts).
import { localeSchema } from "./auth.ts";
import { BRANCH_COPY_KEYS, CENTER_TIMEZONES, type BranchCopyKey } from "../branch-setup.ts";

/**
 * Settings → Branches "Add branch" (F1, OD-12 (b)). Messages are keys under
 * `Settings.branches.errors`. Shape checks only: who may add, to which
 * organization and within which limit is `lib/db/branches.ts`'s call.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null));

/** An unticked checkbox is absent from FormData. */
const tick = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "true");

/** One `copy_<key>` checkbox per copyable part of the setup. */
const copyTicks = Object.fromEntries(BRANCH_COPY_KEYS.map((key) => [`copy_${key}`, tick])) as Record<
  `copy_${BranchCopyKey}`,
  typeof tick
>;

export const addBranchSchema = z
  .object({
    locale: localeSchema,
    name: z.string().trim().min(1, "required").max(120, "tooLong"),
    nameEn: optionalText(120),
    themeColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "invalidColor"),
    timezone: z.enum(CENTER_TIMEZONES, { error: "invalidTimezone" }),
    copyFromCenterId: z.string().trim().min(1, "sourceNotFound").max(64, "sourceNotFound"),
    ...copyTicks,
  })
  .transform((value) => ({
    locale: value.locale,
    name: value.name,
    nameEn: value.nameEn,
    themeColor: value.themeColor,
    timezone: value.timezone,
    copyFromCenterId: value.copyFromCenterId,
    copy: BRANCH_COPY_KEYS.filter((key) => value[`copy_${key}`]),
  }));
