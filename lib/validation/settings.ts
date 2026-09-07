import { z } from "zod";

// Relative imports on purpose: this module and everything it pulls in stay
// resolvable outside the Next.js runtime, so `npm run check:config` can
// exercise the real schemas (same reasoning as lib/db/tenant-scope.ts).
import { localeSchema } from "./auth.ts";
import { MAX_PIASTRES, parseEgpToPiastres } from "../money.ts";

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

/** An optional foreign-key select — "" (the placeholder option) means null. */
const optionalRef = z
  .string()
  .trim()
  .max(64, "notFound")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

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

export const recordToggleSchema = z.object({
  ...base,
  id: recordId,
  active: checkbox,
});

export const recordDeleteSchema = z.object({ ...base, id: recordId });

// ── The academic catalog (M13) ──────────────────────────────────────────────
// A centre picks a global catalog entry (never authors one), may edit only
// its own display name + price for that pick, and may suggest a missing or
// wrong entry into the platform-admin review queue.
// (docs/00-master-product-spec.md §5.1 "Global academic catalog".)

export const catalogEntryKindSchema = z.enum(["EDUCATION_SYSTEM", "GRADE", "SUBJECT"], {
  error: "notFound",
});

export const catalogSelectSchema = z.object({
  ...base,
  kind: catalogEntryKindSchema,
  catalogId: recordId,
  /** Optional at select time — a centre can rename later from its own list. */
  displayName: z
    .string()
    .trim()
    .max(80, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  /** Only meaningful for kind = EDUCATION_SYSTEM; ignored otherwise. */
  basePrice: moneyEgp,
});

export const catalogSelectionUpdateSchema = z.object({
  ...base,
  selectionId: recordId,
  displayName: z
    .string()
    .trim()
    .max(80, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  basePrice: moneyEgp,
});

export const catalogDeselectSchema = z.object({ ...base, selectionId: recordId });

export const catalogSelectionToggleSchema = z.object({
  ...base,
  selectionId: recordId,
  active: checkbox,
});

export const catalogSuggestionSchema = z.object({
  ...base,
  kind: catalogEntryKindSchema,
  /** Set only when suggesting a correction to an existing entry. */
  targetId: optionalRef,
  /** The parent a new GRADE/SUBJECT should hang off — ignored for EDUCATION_SYSTEM. */
  parentId: optionalRef,
  proposedNameAr: z.string().trim().min(1, "required").max(120, "tooLong"),
  proposedNameEn: z.string().trim().min(1, "required").max(120, "tooLong"),
  note: z
    .string()
    .trim()
    .max(400, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const catalogSuggestionResolveSchema = z.object({
  ...base,
  suggestionId: recordId,
});

// ── General settings (default center cut, timeout, late threshold) ─────────

export const MAX_TIMEOUT_DAYS = 3650;
export const MAX_LATE_THRESHOLD = 240;
export const MAX_EDIT_DEADLINE_HOURS = 24 * 365;

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
    };
  });

// ── ID-card customization ──────────────────────────────────────────────────

export const MAX_CARD_LAYOUT_CHARS = 20_000;

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

    return { locale: value.locale, cardLayout: parsed as Record<string, unknown> };
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
  role: z.enum(["OWNER", "MANAGER", "RECEPTIONIST", "ACCOUNTANT", "TEACHER"], {
    error: "notFound",
  }),
});

export const memberActiveSchema = z.object({
  ...base,
  membershipId: recordId,
  active: checkbox,
});
