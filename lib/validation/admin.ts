import { z } from "zod";

// Relative imports on purpose — `npm run check:admin` exercises the real
// schemas outside the Next.js runtime (same reasoning as
// lib/validation/settings.ts).
import { localeSchema } from "./auth.ts";
import { MAX_PRICE_PIASTRES, parseEgpToPiastres } from "../money.ts";
import { MAX_BRANCH_LIMIT } from "../branch-setup.ts";

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
    }),
  ]),
);

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

/** M19 — per-centre override of the data-visibility window (docs/01 §7). */
export const centerVisibilityWindowSchema = z.object({
  locale: localeSchema,
  id: centerId,
  dataVisibilityDays: z.coerce
    .number({ error: "invalidNumber" })
    .int("invalidNumber")
    .min(1, "invalidNumber")
    .max(3650, "invalidNumber"),
});
