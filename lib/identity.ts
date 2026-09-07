/**
 * Identity matching — one `User` per person, keyed on verified phone/email
 * (spec §5 "Identity & duplicates", docs/02-architecture.md §3).
 *
 * Registering a person who already exists creates a **new membership /
 * StudentProfile against the existing User**, never a second person. This
 * module owns the predicate that decides "is this the same human?", and it is
 * deliberately free of runtime imports so `npm run check:people` can exercise
 * the real predicate outside the Next.js runtime.
 */

// Phone normalization lives in exactly one place: `lib/phone.ts` (M18,
// CLAUDE.md rule 10) — imported, never redefined, here or anywhere else.
import { normalizePhone } from "./phone.ts";

/** How a candidate matched — surfaced in the UI so nothing merges silently. */
export type ContactMatchField = "email" | "phone";

export type ContactInput = {
  email?: string | null;
  phone?: string | null;
};

export function normalizeEmail(input: string | null | undefined): string | null {
  const value = (input ?? "").trim().toLowerCase();
  return value.length > 0 ? value : null;
}

/** The normalized pair a match is made on. Nulls mean "nothing to match with". */
export function normalizeContact(input: ContactInput): {
  email: string | null;
  phone: string | null;
} {
  return {
    email: normalizeEmail(input.email),
    phone: normalizePhone(input.phone),
  };
}

/** A minimal `User` shape — everything the matcher and the UI need. */
export type IdentityUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  authId: string | null;
};

/**
 * The Prisma `where` that finds an existing person by verified contact.
 * Returns null when the input carries nothing matchable — in which case the
 * caller creates a new person rather than matching everyone with no email.
 */
export function contactMatchWhere(input: ContactInput): {
  OR: ({ email: string } | { phone: string })[];
} | null {
  const { email, phone } = normalizeContact(input);
  const clauses: ({ email: string } | { phone: string })[] = [];
  if (email) clauses.push({ email });
  if (phone) clauses.push({ phone });
  return clauses.length > 0 ? { OR: clauses } : null;
}

/** Which field(s) of a candidate actually matched — shown in the match panel. */
export function matchedFields(
  input: ContactInput,
  candidate: Pick<IdentityUser, "email" | "phone">,
): ContactMatchField[] {
  const { email, phone } = normalizeContact(input);
  const fields: ContactMatchField[] = [];
  if (email && normalizeEmail(candidate.email) === email) fields.push("email");
  if (phone && normalizePhone(candidate.phone) === phone) fields.push("phone");
  return fields;
}

export function fullName(user: Pick<IdentityUser, "firstName" | "lastName">): string {
  return [user.firstName, user.lastName.replace(/^-+$/, "")]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * The name to show/edit for a person **at this center** — a
 * `StudentProfile`/`Membership` local record (docs/01-data-model.md §2, §6).
 *
 * Name is center-local, exactly like email/phone/altPhone: it is seeded from
 * the global `User` the moment this center's record is created (`register`
 * or `add-existing-person`), then editable here immediately and
 * independently of what any other center stores or what the global `User`
 * says — never locked, and never written back to `User`.
 *
 * The fallback to `global` only matters for a record whose local name was
 * never seeded (a Membership created by the older staff-invite path, which
 * does not go through the people screens this module supports) — everything
 * created via `register`/`add-existing-person` always has a local name.
 */
export function localName(
  local: { firstName: string | null; lastName: string | null },
  global: Pick<IdentityUser, "firstName" | "lastName">,
): { firstName: string; lastName: string } {
  return {
    firstName: local.firstName ?? global.firstName,
    lastName: local.lastName ?? global.lastName,
  };
}
