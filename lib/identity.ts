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

/**
 * Egyptian mobile numbers to one canonical `01XXXXXXXXX`, so the same person
 * typed as `+201012345678`, `00201012345678` or `01012345678` is one identity.
 * Returns null for anything that is not an Egyptian mobile.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  const digits = (input ?? "").replace(/[^\d]/g, "");
  if (digits.length === 0) return null;

  let local = digits;
  if (local.startsWith("0020")) local = local.slice(4);
  else if (local.startsWith("20") && local.length > 11) local = local.slice(2);
  if (!local.startsWith("0")) local = `0${local}`;

  return /^01[0125]\d{8}$/.test(local) ? local : null;
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
 * May this center edit the person's **global** profile (name, email, phone)?
 *
 * Identity is global (CLAUDE.md rule 4): renaming a teacher who also works at
 * another center, or who has signed in and owns their account, would rewrite
 * them everywhere. So the global fields are editable only for a person this
 * center created and who exists nowhere else. Center-owned fields (parent
 * details, grade, student code, photo, membership flags) are always editable.
 */
export function canEditGlobalProfile(input: {
  authId: string | null;
  /** Memberships + student profiles the person holds outside this center. */
  otherCenterRelations: number;
}): boolean {
  return input.authId === null && input.otherCenterRelations === 0;
}
