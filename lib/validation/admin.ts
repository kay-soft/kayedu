import { z } from "zod";

// Relative imports on purpose — `npm run check:admin` exercises the real
// schemas outside the Next.js runtime (same reasoning as
// lib/validation/settings.ts).
import { localeSchema } from "./auth.ts";
import { MAX_PRICE_PIASTRES, parseEgpToPiastres } from "../money.ts";
import { BRANCH_COPY_KEYS, BRANCH_PAUSE_REASON_MAX, MAX_BRANCH_LIMIT, type BranchCopyKey } from "../branch-setup.ts";
import { dateKeyField } from "./class-period.ts";
import { visibilityWindowField } from "./settings.ts";
import {
  DEFAULT_CENTER_VISIBILITY_DAYS,
  DEFAULT_TEACHER_VISIBILITY_DAYS,
  MAX_CENTER_VISIBILITY_DAYS,
  MAX_TEACHER_VISIBILITY_DAYS,
} from "../db/visibility.ts";

/**
 * Platform-admin schemas (M9). Messages are i18n keys under
 * `AdminCenters.errors`, never user-facing copy (docs/02 §7).
 */

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

/**
 * An organization id from a form (F1). Opaque: the M11 backfill reused each
 * centre's id as its organization's, so it is not assumed to be a uuid — the
 * lookup decides.
 */
const organizationId = z.string().trim().min(1, "organizationNotFound").max(64, "organizationNotFound");

/** `Organization.maxBranches` as typed (F1) — `lib/db/platform.ts` re-checks it. */
const maxBranches = z.coerce
  .number({ error: "invalidLimit" })
  .int("invalidLimit")
  .min(1, "invalidLimit")
  .max(MAX_BRANCH_LIMIT, "invalidLimit");

/** An unticked checkbox is absent from FormData. */
const tick = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "true");

/** One `copy_<key>` checkbox per copyable part of a branch's setup (F1, U5). */
const copyTicks = Object.fromEntries(BRANCH_COPY_KEYS.map((key) => [`copy_${key}`, tick])) as Record<
  `copy_${BranchCopyKey}`,
  typeof tick
>;

const branchFields = {
  locale: localeSchema,
  name: centerName,
  nameEn: optionalText(120),
  slug,
  // No logo URL (SEC-53, D-25 (b)): the logo is an uploaded file, checked by
  // its bytes and stored in the private `logos` bucket — never a URL the
  // server would fetch.
  themeColor,
};

/**
 * The admin's create form (F1, OD-12 (a)): **New organization** — the branch,
 * the organization it founds (its name defaults to the branch's when left
 * blank, its branch limit to 1) and the founding Owner's invitation — or
 * **Add to an existing organization**, which names the organization and
 * invites nobody (its Owner already resolves every branch). A post with no
 * mode is the pre-F1 form: a new organization.
 */
export const createCenterSchema = z.preprocess(
  (raw) =>
    raw && typeof raw === "object" && !("organizationMode" in raw)
      ? { ...raw, organizationMode: "new" }
      : raw,
  z.discriminatedUnion("organizationMode", [
    z.object({
      ...branchFields,
      organizationMode: z.literal("new"),
      organizationName: optionalText(120),
      organizationNameEn: optionalText(120),
      maxBranches: maxBranches.default(1),
      ownerEmail,
    }),
    z.object({
      ...branchFields,
      organizationMode: z.literal("existing"),
      organizationId,
      // U5: "Copy setup from <branch>" moved here from the Owner's retired
      // Settings → Branches. Empty = copy nothing; the data layer checks the
      // source belongs to the organization.
      copyFromCenterId: z
        .string()
        .trim()
        .max(64, "sourceNotFound")
        .optional()
        .transform((value) => (value && value.length > 0 ? value : null)),
      ...copyTicks,
    }),
  ]),
);

/** The ticked copy keys of a parsed "existing organization" post, in catalogue order. */
export function copyKeysFrom(value: Partial<Record<`copy_${BranchCopyKey}`, boolean>>): BranchCopyKey[] {
  return BRANCH_COPY_KEYS.filter((key) => value[`copy_${key}`]);
}

/** F1 — the platform admin's branch-limit editor on `/admin/organizations/[id]`. */
export const organizationBranchLimitSchema = z.object({
  locale: localeSchema,
  id: organizationId,
  maxBranches,
});

/** M19 — the five-state lifecycle replacing `Center.active` (docs/00 §5.1). */
const centerLifecycleState = z.enum(["ONBOARDING", "ACTIVE", "GRACE", "SUSPENDED", "ARCHIVED"], {
  error: "invalidLifecycleState",
});

export const centerLifecycleTransitionSchema = z.object({
  locale: localeSchema,
  id: centerId,
  to: centerLifecycleState,
});

// ── The global catalog (R8) ─────────────────────────────────────────────────
// Shape checks only. The rules that decide whether a catalog write is allowed
// (both names present and 1..80, no duplicate within a parent, the parent
// exists, the share is a sane piastre amount) live in `lib/db/catalog-admin.ts`
// — that is the authority, so a direct call and a form post cannot disagree —
// and come back as `AdminCatalog.errors` keys.

const catalogKind = z.enum(["EDUCATION_SYSTEM", "GRADE", "SUBJECT"], { error: "notFound" });
const catalogEntryId = z.string().trim().min(1, "notFound").max(64, "notFound");

/** A name field as typed; emptiness and length are the authority's call, so it can name which language. */
const catalogNameField = z.string().default("");

/** The default centre cut, typed in EGP and parsed once (CLAUDE.md rule 2 — stored as piastres). */
const catalogShareEgp = z
  .string()
  .trim()
  .default("")
  .transform((value) => (value === "" ? 0 : parseEgpToPiastres(value, MAX_PRICE_PIASTRES)))
  .refine((value): value is number => value !== null, "invalidAmount");

const catalogEntryFields = {
  locale: localeSchema,
  kind: catalogKind,
  nameAr: catalogNameField,
  nameEn: catalogNameField,
  /** "" (the "none" option) means no parent. */
  parentId: z
    .string()
    .trim()
    .max(64, "parentNotFound")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  defaultFixedCenterShare: catalogShareEgp,
  /** A subject's grades (U3), posted as repeated `gradeIds` fields — the action reads them with `getAll`. */
  gradeIds: z.array(z.string().trim().min(1, "gradeNotFound").max(64, "gradeNotFound")).max(500).default([]),
};

export const catalogEntryCreateSchema = z.object(catalogEntryFields);

export const catalogEntryUpdateSchema = z.object({ ...catalogEntryFields, id: catalogEntryId });

export const catalogEntryToggleSchema = z.object({
  locale: localeSchema,
  kind: catalogKind,
  id: catalogEntryId,
  active: z.enum(["true", "false"], { error: "notFound" }).transform((value) => value === "true"),
});

export const catalogEntryDeleteSchema = z.object({
  locale: localeSchema,
  kind: catalogKind,
  id: catalogEntryId,
});

/**
 * M19, U6 — the platform admin's override of a branch's two data-visibility
 * windows (docs/01 §7), under the same caps a branch's own settings get.
 */
export const centerVisibilityWindowSchema = z.object({
  locale: localeSchema,
  id: centerId,
  centerDataVisibilityDays: visibilityWindowField(DEFAULT_CENTER_VISIBILITY_DAYS, MAX_CENTER_VISIBILITY_DAYS),
  teacherDataVisibilityDays: visibilityWindowField(DEFAULT_TEACHER_VISIBILITY_DAYS, MAX_TEACHER_VISIBILITY_DAYS),
});

// ── Branch management by a platform admin (U5) ─────────────────────────────
// Shape checks only. Whether a pause, delete or restore is allowed (range,
// one live pause, the only branch, a live session, open settlements, the
// restore window, the limit) is `lib/db/branch-admin.ts`'s call.

/** A branch id from an admin form — opaque, like an organization's (the seeded branches predate uuids). */
const branchId = z.string().trim().min(1, "notFound").max(64, "notFound");

/** Edit a branch: names and theme colour — never the slug or the timezone. */
export const branchEditSchema = z.object({
  locale: localeSchema,
  id: branchId,
  name: centerName,
  nameEn: optionalText(120),
  themeColor,
});

/** Pause a branch: `intent` is "preview" (nothing written) or "confirm". */
export const branchPauseSchema = z.object({
  locale: localeSchema,
  id: branchId,
  intent: z.enum(["preview", "confirm"], { error: "notFound" }),
  startDate: dateKeyField,
  endDate: dateKeyField,
  reason: optionalText(BRANCH_PAUSE_REASON_MAX),
});

export const branchPauseEndSchema = z.object({
  locale: localeSchema,
  id: branchId,
  pauseId: z.string().trim().min(1, "notFound").max(64, "notFound"),
});

/** Delete a branch: the admin types its name; the data layer compares it. */
export const branchDeleteSchema = z.object({
  locale: localeSchema,
  id: branchId,
  confirmName: z.string().trim().min(1, "nameMismatch").max(200, "nameMismatch"),
});

export const branchRestoreSchema = z.object({
  locale: localeSchema,
  id: branchId,
});
