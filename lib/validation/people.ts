import { z } from "zod";

// Relative imports on purpose: this module and everything it pulls in stay
// resolvable outside the Next.js runtime, so `npm run check:people` can
// exercise the real schemas (same reasoning as ./settings.ts).
import { localeSchema } from "./auth.ts";
import { normalizeEmail, normalizePhone } from "../identity.ts";

/**
 * Teacher & student schemas (M3, revised). Every Server Action parses its
 * input through one of these before touching the database (docs/02 §7).
 *
 * Messages are **i18n keys** under `People.errors`, never user-facing copy.
 */

/** A record id from a form — opaque to the UI; the scoped lookup decides. */
const recordId = z.string().trim().min(1, "notFound").max(64, "notFound");

const optionalRecordId = z
  .string()
  .trim()
  .max(64, "notFound")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

const personName = z.string().trim().min(1, "required").max(60, "tooLong");

const optionalPersonName = z
  .string()
  .trim()
  .max(60, "tooLong")
  .optional()
  .transform((value) => (value && value.length > 0 ? value : null));

/** Optional email, normalized so the same address always matches the same way. */
const optionalEmail = z
  .string()
  .trim()
  .max(254, "tooLong")
  .optional()
  .transform((value) => normalizeEmail(value))
  .refine(
    (value) => value === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    "invalidEmail",
  );

/**
 * Optional Egyptian mobile, stored in one canonical `01XXXXXXXXX` form so the
 * duplicate match cannot be dodged by typing `+20…` instead (spec §5).
 */
const optionalPhone = z
  .string()
  .trim()
  .max(20, "tooLong")
  .optional()
  .transform((value, ctx) => {
    if (!value || value.length === 0) return null;
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "invalidPhone" });
      return z.NEVER;
    }
    return normalized;
  });

/** An unchecked checkbox is absent from FormData, which means false. */
const checkbox = z
  .string()
  .optional()
  .transform((value) => value === "on" || value === "true");

const base = { locale: localeSchema };

/**
 * The person this form should be linked to instead of creating a new one.
 * Present only after the duplicate-match panel has been confirmed — a match is
 * always shown before it is acted on, never merged silently (spec §5).
 */
const linkUserId = optionalRecordId;

// ── Teachers ───────────────────────────────────────────────────────────────

/**
 * `firstName`/`lastName` are the person's **global** identity — applied only
 * when creating a brand-new person (docs/01 §6). `email`/`phone`/`altPhone`
 * are this **center's own local contact record** for them — always editable
 * here, seeded onto the global `User` only at first creation.
 */
const teacherFields = {
  firstName: personName,
  lastName: personName,
  email: optionalEmail,
  phone: optionalPhone,
  altPhone: optionalPhone,
};

/**
 * A teacher needs at least one contact on file at this center: it is what a
 * duplicate match keys on, and it is how they eventually claim their
 * cross-center portal account (docs/00 §4.2). Students may legitimately have
 * neither — they are minors, and the parent's phone is the contact.
 */
function requireContact(
  value: { email: string | null; phone: string | null },
  ctx: z.RefinementCtx,
): void {
  if (!value.email && !value.phone) {
    ctx.addIssue({ code: "custom", path: ["phone"], message: "contactRequired" });
  }
}

export const teacherCreateSchema = z
  .object({ ...base, ...teacherFields, linkUserId })
  .superRefine(requireContact);

export const teacherUpdateSchema = z
  .object({ ...base, ...teacherFields, membershipId: recordId })
  .superRefine(requireContact);

export const membershipActionSchema = z.object({
  ...base,
  membershipId: recordId,
});

export const membershipActiveSchema = z.object({
  ...base,
  membershipId: recordId,
  active: checkbox,
});

// ── Students ───────────────────────────────────────────────────────────────

const studentFields = {
  firstName: personName,
  lastName: personName,
  email: optionalEmail,
  phone: optionalPhone,
  altPhone: optionalPhone,
  gradeId: optionalRecordId,
  parentFirstName: optionalPersonName,
  parentLastName: optionalPersonName,
  parentPhone: optionalPhone,
  parentAltPhone: optionalPhone,
};

export const studentCreateSchema = z.object({
  ...base,
  ...studentFields,
  linkUserId,
});

export const studentUpdateSchema = z.object({
  ...base,
  ...studentFields,
  studentProfileId: recordId,
});

export const studentActionSchema = z.object({
  ...base,
  studentProfileId: recordId,
});

export const studentActiveSchema = z.object({
  ...base,
  studentProfileId: recordId,
  active: checkbox,
});

// ── Grade promotion (end of term, Manager) ─────────────────────────────────

/** Bulk: everyone currently in one grade moves to the next. */
export const gradePromotionSchema = z
  .object({
    ...base,
    fromGradeId: recordId,
    toGradeId: recordId,
  })
  .refine((value) => value.fromGradeId !== value.toGradeId, {
    path: ["toGradeId"],
    message: "samePromotionGrade",
  });

/** Per-student: move one student to a grade (or clear it). */
export const studentGradeSchema = z.object({
  ...base,
  studentProfileId: recordId,
  gradeId: optionalRecordId,
});

// ── Blocking (teacher block-list) ──────────────────────────────────────────

export const blockCreateSchema = z.object({
  ...base,
  /** The teacher's **User** id — `StudentBlock.refId` for scope TEACHER. */
  teacherUserId: recordId,
  studentProfileId: recordId,
  reason: z
    .string()
    .trim()
    .max(200, "tooLong")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
});

export const blockRemoveSchema = z.object({ ...base, blockId: recordId });

// ── Photo upload (Supabase Storage `avatars/{centerId}/…`) ─────────────────

/** The file itself is checked in the action — zod owns the rest of the form. */
export const studentPhotoSchema = z.object({
  ...base,
  studentProfileId: recordId,
});

// ── List pagination (students & teachers dashboards) ───────────────────────

export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * A page number from the URL — never trusted raw. Clamped rather than
 * rejected, since a stale/bookmarked `?page=` is a UX papercut, not an error.
 */
export function parsePageParam(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function parsePageSizeParam(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_PAGE_SIZE
    ? parsed
    : DEFAULT_PAGE_SIZE;
}

// ── Action state ───────────────────────────────────────────────────────────

/**
 * A person who already exists, surfaced to the UI before anything is linked.
 * "This person already exists — linking to their existing profile", never a
 * silent merge (spec §5).
 */
export type MatchCandidate = {
  userId: string;
  name: string;
  /**
   * The contact value(s) as typed into *this* form — echoed back so staff can
   * sanity-check the match, not pulled from another center's local record
   * (which this center has no business displaying verbatim).
   */
  email: string | null;
  phone: string | null;
  /** Which contact field matched — shown so staff can sanity-check it. */
  matchedOn: ("email" | "phone")[];
  /** Set when this person is already connected to this center. */
  existingHere: "student" | "teacher" | "staff" | null;
  /** The StudentProfile id when `existingHere === "student"` — links to them. */
  existingProfileId?: string;
};

/**
 * What the people actions return. `error` and the values in `fieldErrors` are
 * i18n keys under `People.errors`, not copy.
 */
export type PeopleActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "created" | "saved" | "deleted" | "matchFound" | "generated";
  match?: MatchCandidate;
  /** A short-lived signed URL for a freshly generated ID card. */
  downloadUrl?: string;
};

export const IDLE_PEOPLE_STATE: PeopleActionState = {};
