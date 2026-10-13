import { z } from "zod";

// Relative imports on purpose: this module and everything it pulls in stay
// resolvable outside the Next.js runtime, so `npm run check:config` can
// exercise the real schemas (same reasoning as lib/db/tenant-scope.ts).
import { localeSchema, staffRoleField } from "./auth.ts";
import {
  CARD_BOUNDS,
  CARD_BRANCH_TEXT_MAX,
  CARD_FONT_FAMILY_KEYS,
  CARD_TEXT_ALIGNS,
  DEFAULT_CARD_BACKGROUND,
} from "../card-layout.ts";
import { CATALOG_NAME_MAX } from "../catalog.ts";
import { MAX_PIASTRES, parseEgpToPiastres } from "../money.ts";
import { extraRoomIdsField } from "./room-set.ts";
import { dateOnlyField, withPeriodRule } from "./class-period.ts";

/**
 * Center-configuration schemas (M2). Every Server Action parses its input
 * through one of these before touching the database (docs/02 §7).
 *
 * Messages are **i18n keys** under `Settings.errors`, never user-facing copy.
 */

/**
 * A record id from a form. Deliberately not `.uuid()`: ids are opaque to the
 * UI and the seeded main branch uses a derived id, so validating the shape
 * here would reject a legitimate row. The scoped lookup is what actually
 * decides whether an id resolves — an id from another center returns null.
 */
const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

const entityName = z.string().trim().min(1, "required").max(80, "tooLong");

/** An unchecked checkbox is absent from FormData, which means false. */
const checkbox = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "true");

/** A whole, non-negative count typed into a number input. */
const wholeNumber = (max: number) =>
  z
    .string()
    .trim()
    .default("0")
    .transform((value) => (value === "" ? 0 : Number(value)))
    .refine(
      (value) => Number.isInteger(value) && value >= 0 && value <= max,
      "invalidNumber",
    );

/** An EGP amount typed into a form, stored as piastres (CLAUDE.md rule 2). */
const moneyEgp = z
  .string()
  .trim()
  .default("0")
  .transform((value) => (value === "" ? 0 : parseEgpToPiastres(value)))
  .refine((value): value is number => value !== null, "invalidAmount");

const base = { locale: localeSchema };

// ── Master data ────────────────────────────────────────────────────────────
// Education systems/grades/subjects moved to the platform-owned global
// catalog at M13 — a centre no longer authors these rows (see the catalog
// schemas further down). Rooms are the one entity still centre-authored.

export const roomSchema = z.object({
  ...base,
  name: entityName,
  capacity: wholeNumber(10_000),
});

/** Every master-data update carries the id of the row being edited. */
export const roomUpdateSchema = roomSchema.extend({ id: recordId });

/**
 * "Can be combined with" for one room (R3): the full set of rooms it should
 * be linked to after the save — links are added and removed to match.
 */
export const roomLinksSchema = z.object({
  ...base,
  roomId: recordId,
  linkedRoomIds: extraRoomIdsField,
});

export const recordToggleSchema = z.object({
  ...base,
  id: recordId,
  active: checkbox,
});

export const recordDeleteSchema = z.object({ ...base, id: recordId });

// ── Payment methods (R1) ───────────────────────────────────────────────────
// One centre-entered name, like a room's. The "at least one active" and
// "referenced → deactivate" rules are not shape rules, so they live in
// lib/db/payment-methods.ts, not here.

export const paymentMethodSchema = z.object({ ...base, name: entityName });

export const paymentMethodUpdateSchema = paymentMethodSchema.extend({ id: recordId });

// ── Terms (R4) ──────────────────────────────────────────────────────────────
// A centre's term presets: one centre-entered name plus a period. The
// case-insensitive name rule is not a shape rule, so it lives in
// lib/db/terms.ts; the period rule is the shared one a class follows.

const termFields = { ...base, name: entityName, startDate: dateOnlyField, endDate: dateOnlyField };

export const termSchema = z.object(termFields).superRefine(withPeriodRule);

export const termUpdateSchema = z
  .object({ ...termFields, id: recordId })
  .superRefine(withPeriodRule);

// ── The academic catalog (M13, R8) ──────────────────────────────────────────
// A centre picks a global catalog entry (never authors one — a platform admin
// adds entries; a centre that needs one contacts us), and may edit only its
// own price and its own display name for that pick — one optional name per
// language, a blank field reverting to the catalog's name. There is no
// suggestion path. (docs/00-master-product-spec.md §5.1 "Global academic
// catalog".)

export const catalogEntryKindSchema = z.enum(["EDUCATION_SYSTEM", "GRADE", "SUBJECT"], {
  error: "notFound",
});

/** One optional per-language rename: trimmed, blank = "no override" (null), 80 characters at most. */
const catalogRename = z
  .string()
  .trim()
  .max(CATALOG_NAME_MAX, "tooLong")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

export const catalogSelectSchema = z.object({
  ...base,
  kind: catalogEntryKindSchema,
  catalogId: recordId,
  /** Only meaningful for kind = EDUCATION_SYSTEM; ignored otherwise. */
  basePrice: moneyEgp,
});

export const catalogSelectionUpdateSchema = z.object({
  ...base,
  selectionId: recordId,
  displayNameAr: catalogRename,
  displayNameEn: catalogRename,
  basePrice: moneyEgp,
});

export const catalogDeselectSchema = z.object({ ...base, selectionId: recordId });

export const catalogSelectionToggleSchema = z.object({
  ...base,
  selectionId: recordId,
  active: checkbox,
});

// ── General settings (default center cut, timeout, late threshold) ─────────

export const MAX_TIMEOUT_DAYS = 3650;
export const MAX_LATE_THRESHOLD = 240;
export const MAX_EDIT_DEADLINE_HOURS = 24 * 365;
/** M19 — the data-visibility window (docs/01 §7); 1 is the floor, not 0, since a 0-day window is not a meaningful setting. */
export const MAX_VISIBILITY_WINDOW_DAYS = 3650;

const visibilityWindowDays = z
  .string()
  .trim()
  .default("30")
  .transform((value) => (value === "" ? 30 : Number(value)))
  .refine(
    (value) => Number.isInteger(value) && value >= 1 && value <= MAX_VISIBILITY_WINDOW_DAYS,
    "invalidNumber",
  );

export const generalSettingsSchema = z
  .object({
    ...base,
    defaultShareType: z.enum(["FIXED", "PERCENTAGE"], {
      error: "invalidShareType",
    }),
    /** Percent when PERCENTAGE, EGP when FIXED — resolved below. */
    shareValue: z.string().trim().min(1, "required"),
    teacherTimeoutEnabled: checkbox,
    teacherTimeoutDays: z.string().trim().optional(),
    defaultLateThreshold: wholeNumber(MAX_LATE_THRESHOLD),
    timezone: z.string().trim().min(1, "required").max(64, "tooLong"),
    // Whether a teacher/room double-booking is denied outright or merely
    // saved-and-flagged (docs/02-architecture.md §11). Off (WARN) by default —
    // the same "widen carefully" spirit as the permission grants.
    denyScheduleConflicts: checkbox,
    // A teacher's deadline to edit their own session description, in hours
    // after the session date (M10, closing the gap flagged at M5/M7). Off by
    // default — editable any time, the M7 behavior.
    teacherEditDeadlineEnabled: checkbox,
    teacherEditDeadlineHours: z.string().trim().optional(),
    dataVisibilityDays: visibilityWindowDays,
  })
  .transform((value, ctx) => {
    // The share value means two different things depending on the mode, so it
    // is validated against the mode rather than in isolation.
    let defaultShareValue: number;
    if (value.defaultShareType === "PERCENTAGE") {
      const percent = Number(value.shareValue);
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
        ctx.addIssue({
          code: "custom",
          path: ["shareValue"],
          message: "invalidPercent",
        });
        return z.NEVER;
      }
      defaultShareValue = percent;
    } else {
      const piastres = parseEgpToPiastres(value.shareValue);
      if (piastres === null || piastres > MAX_PIASTRES) {
        ctx.addIssue({
          code: "custom",
          path: ["shareValue"],
          message: "invalidAmount",
        });
        return z.NEVER;
      }
      defaultShareValue = piastres;
    }

    // "Teacher timeout: none" is stored as null, not as 0 days.
    let teacherTimeoutDays: number | null = null;
    if (value.teacherTimeoutEnabled) {
      const days = Number(value.teacherTimeoutDays ?? "");
      if (!Number.isInteger(days) || days < 1 || days > MAX_TIMEOUT_DAYS) {
        ctx.addIssue({
          code: "custom",
          path: ["teacherTimeoutDays"],
          message: "invalidNumber",
        });
        return z.NEVER;
      }
      teacherTimeoutDays = days;
    }

    // "Teacher edit deadline: off" is stored as null, not as 0 hours.
    let teacherEditDeadlineHours: number | null = null;
    if (value.teacherEditDeadlineEnabled) {
      const hours = Number(value.teacherEditDeadlineHours ?? "");
      if (!Number.isInteger(hours) || hours < 1 || hours > MAX_EDIT_DEADLINE_HOURS) {
        ctx.addIssue({
          code: "custom",
          path: ["teacherEditDeadlineHours"],
          message: "invalidNumber",
        });
        return z.NEVER;
      }
      teacherEditDeadlineHours = hours;
    }

    return {
      locale: value.locale,
      defaultShareType: value.defaultShareType,
      defaultShareValue,
      teacherTimeoutDays,
      defaultLateThreshold: value.defaultLateThreshold,
      timezone: value.timezone,
      scheduleConflictPolicy: value.denyScheduleConflicts
        ? ("DENY" as const)
        : ("WARN" as const),
      teacherEditDeadlineHours,
      dataVisibilityDays: value.dataVisibilityDays,
    };
  });

// ── ID-card customization ──────────────────────────────────────────────────

export const MAX_CARD_LAYOUT_CHARS = 20_000;

/**
 * The stored shape of `CenterSettings.cardLayout` (R9) — strict on every
 * level: unknown keys are refused, colours are `#RRGGBB` only, fonts and
 * alignments come from closed lists, sizes are bounded, and an element may only
 * carry the fields it has (`CARD_ELEMENT_FIELDS`). No CSS string is ever
 * stored. Every field is optional because "absent" means today's default — an
 * older layout stays valid, and the resolver (`lib/id-card.ts`) does the
 * defaulting. A `null` element is "removed from the card" (M18).
 */
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toLowerCase());
const position = z.number().min(CARD_BOUNDS.position.min).max(CARD_BOUNDS.position.max);
const imageWidth = z.number().min(CARD_BOUNDS.imageWidth.min).max(CARD_BOUNDS.imageWidth.max);
const textWidth = z.number().min(CARD_BOUNDS.textWidth.min).max(CARD_BOUNDS.textWidth.max);

const imageElement = z
  .strictObject({
    x: position.optional(),
    y: position.optional(),
    width: imageWidth.optional(),
  })
  .nullable();

const textElementShape = {
  x: position.optional(),
  y: position.optional(),
  width: textWidth.optional(),
  fontSize: z.number().min(CARD_BOUNDS.fontSize.min).max(CARD_BOUNDS.fontSize.max).optional(),
  weight: z.number().int().min(CARD_BOUNDS.weight.min).max(CARD_BOUNDS.weight.max).optional(),
  color: hexColor.optional(),
  align: z.enum(CARD_TEXT_ALIGNS).optional(),
  family: z.enum(CARD_FONT_FAMILY_KEYS).optional(),
};

const textElement = z.strictObject(textElementShape).nullable();

const branchNameElement = z
  .strictObject({
    ...textElementShape,
    // Blank is allowed and means "use the real name" (the resolver ignores it).
    text: z
      .string()
      .trim()
      .max(CARD_BRANCH_TEXT_MAX)
      .regex(/^[^\p{Cc}]*$/u)
      .optional(),
  })
  .nullable();

export const cardLayoutDocumentSchema = z.strictObject({
  version: z.literal(1).optional(),
  background: z.union([z.literal(DEFAULT_CARD_BACKGROUND), hexColor]).optional(),
  accent: hexColor.optional(),
  footer: hexColor.optional(),
  headerBand: z.boolean().optional(),
  elements: z
    .strictObject({
      logo: imageElement.optional(),
      centerName: branchNameElement.optional(),
      photo: imageElement.optional(),
      studentName: textElement.optional(),
      grade: textElement.optional(),
      studentCode: textElement.optional(),
      qr: imageElement.optional(),
    })
    .optional(),
});

export const cardLayoutSchema = z
  .object({
    ...base,
    cardLayout: z.string().max(MAX_CARD_LAYOUT_CHARS, "tooLong"),
  })
  .transform((value, ctx) => {
    const raw = value.cardLayout.trim();
    // Empty means "no customization" — fall back to the built-in card layout.
    if (raw === "") return { locale: value.locale, cardLayout: null };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["cardLayout"],
        message: "invalidJson",
      });
      return z.NEVER;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      ctx.addIssue({
        code: "custom",
        path: ["cardLayout"],
        message: "cardLayoutNotObject",
      });
      return z.NEVER;
    }

    const layout = cardLayoutDocumentSchema.safeParse(parsed);
    if (!layout.success) {
      ctx.addIssue({
        code: "custom",
        path: ["cardLayout"],
        message: "invalidCardLayout",
      });
      return z.NEVER;
    }

    return { locale: value.locale, cardLayout: layout.data as Record<string, unknown> };
  });

// ── The permission matrix (M12) ────────────────────────────────────────────

/**
 * The matrix screen submits its whole grid at once as `grant__<role>__<action>`
 * checkboxes (`permissions-form.tsx`) — a dynamic field set zod can't type as
 * a fixed object shape, so the action parses `locale` through this and reads
 * the `grant__` fields directly off the raw `FormData`. Which (role, action)
 * pairs are actually writable is decided server-side by `editableActionsFor()`
 * (`lib/auth/permissions.ts`), never trusted from the field name alone: a
 * forged extra field for a forbidden pair is silently dropped, not written.
 */
export const permissionMatrixSchema = z.object(base);

export const membershipBranchGrantSchema = z.object({
  ...base,
  membershipId: recordId,
  centerId: recordId,
});

// ── Users & roles ──────────────────────────────────────────────────────────

export const memberRoleSchema = z.object({
  ...base,
  membershipId: recordId,
  // Centre staff only (R9) — a TEACHER role is refused here by direct call.
  role: staffRoleField,
});

export const memberActiveSchema = z.object({
  ...base,
  membershipId: recordId,
  active: checkbox,
});
