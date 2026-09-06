import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import {
  fullName,
  normalizeContact,
  normalizeEmail,
  normalizePhone,
  type ContactInput,
  type ContactMatchField,
} from "@/lib/identity";
import type { MatchCandidate } from "@/lib/validation/people";

/**
 * The global identity layer (docs/01-data-model.md §1, §6, spec §5).
 *
 * `User` is the one table with no `centerId` — it is a person, not a tenant
 * row — so it is reached through this module rather than `scoped(ctx)`. What
 * keeps it safe is that nothing here returns tenant data: it answers "does
 * this person already exist?" and "are they already connected to *this*
 * center?", and every center-scoped read around it still goes through
 * `lib/db/scoped.ts`.
 *
 * Contact details are **center-local** (docs/01 §6): a center's own record of
 * a person's email/phone/altPhone lives on `StudentProfile`/`Membership`, not
 * on the global `User`. So the duplicate match has to search three tables —
 * the global identity plus every center's local record — because a person
 * may have been entered with a contact that never made it onto their global
 * `User` (it only seeds `User` at the moment a brand-new person is created).
 */

type ContactMatch = { user: User; matchedOn: ContactMatchField[] };

/**
 * People matching the submitted contact details, searched across the global
 * `User` and every center's local `StudentProfile`/`Membership` record.
 * Returns up to two distinct people, because a form can legitimately hit two
 * different humans (this email is A's, this phone is B's) — that is a
 * conflict a human resolves, not something to merge.
 */
export async function findPeopleByContact(
  input: ContactInput,
): Promise<ContactMatch[]> {
  const { email, phone } = normalizeContact(input);
  if (!email && !phone) return [];

  const userOr: Prisma.UserWhereInput[] = [];
  const localOr: ({ email: string } | { phone: string })[] = [];
  if (email) {
    userOr.push({ email });
    localOr.push({ email });
  }
  if (phone) {
    userOr.push({ phone });
    localOr.push({ phone });
  }

  const [globalUsers, localStudents, localTeachers] = await Promise.all([
    prisma.user.findMany({ where: { OR: userOr } }),
    prisma.studentProfile.findMany({
      where: { OR: localOr },
      include: { user: true },
    }),
    prisma.membership.findMany({
      where: { OR: localOr },
      include: { user: true },
    }),
  ]);

  const byUser = new Map<string, { user: User; matchedOn: Set<ContactMatchField> }>();
  const record = (user: User, contactEmail: string | null, contactPhone: string | null) => {
    const existing = byUser.get(user.id);
    const matchedOn = existing?.matchedOn ?? new Set<ContactMatchField>();
    if (email && contactEmail === email) matchedOn.add("email");
    if (phone && contactPhone === phone) matchedOn.add("phone");
    if (matchedOn.size === 0) return;
    byUser.set(user.id, { user: existing?.user ?? user, matchedOn });
  };

  for (const user of globalUsers) record(user, user.email, user.phone);
  for (const profile of localStudents) record(profile.user, profile.email, profile.phone);
  for (const membership of localTeachers) {
    record(membership.user, membership.email, membership.phone);
  }

  return [...byUser.values()].map(({ user, matchedOn }) => ({
    user,
    matchedOn: [...matchedOn],
  }));
}

/**
 * Memberships + student profiles this person holds at *other* centers. Used
 * by the student detail page's own "other branches" field — a different
 * concern from the teacher-detail leak M12 closes (docs/00-master-product-spec.md
 * §5 "Teacher detail leak"), which is specifically about a centre Owner/
 * Manager seeing which *other centres a teacher works at*. Nothing in M12
 * touches this student-facing count; it is out of that milestone's scope.
 */
export async function countOtherCenterRelations(
  userId: string,
  centerId: string,
): Promise<number> {
  const [memberships, profiles] = await Promise.all([
    prisma.membership.count({ where: { userId, NOT: { centerId } } }),
    prisma.studentProfile.count({ where: { userId, NOT: { centerId } } }),
  ]);
  return memberships + profiles;
}

/**
 * Turns a matched person into what the UI shows before anything is linked:
 * who they are, the contact *this form* was typed with (never another
 * center's stored local record — this center has no business displaying
 * that verbatim), and whether they are already connected here.
 */
export async function describeMatch(
  centerId: string,
  match: ContactMatch,
  input: ContactInput,
): Promise<MatchCandidate> {
  const { user, matchedOn } = match;
  const { email, phone } = normalizeContact(input);
  const [studentProfile, membership] = await Promise.all([
    prisma.studentProfile.findFirst({ where: { userId: user.id, centerId } }),
    prisma.membership.findFirst({ where: { userId: user.id, centerId } }),
  ]);

  let existingHere: MatchCandidate["existingHere"] = null;
  if (studentProfile) existingHere = "student";
  else if (membership) {
    existingHere = membership.role === "TEACHER" ? "teacher" : "staff";
  }

  return {
    userId: user.id,
    name: fullName(user),
    email,
    phone,
    matchedOn,
    existingHere,
    ...(studentProfile ? { existingProfileId: studentProfile.id } : {}),
  };
}

/**
 * Resolves a person for a "add teacher / add student" submission.
 *
 * - `matched` — one existing person: the caller surfaces the match panel and
 *   only links once staff confirm (never a silent merge, spec §5).
 * - `conflict` — the email and the phone belong to two different people.
 *   Merging identities is a manual, audited admin action (docs/02 §3).
 * - `none` — nobody matches; create a new person, seeding the global `User`
 *   from the entered contact (docs/01 §6).
 */
export type ContactResolution =
  | { kind: "none" }
  | { kind: "matched"; match: ContactMatch }
  | { kind: "conflict" };

export async function resolveContact(
  input: ContactInput,
): Promise<ContactResolution> {
  const people = await findPeopleByContact(input);
  if (people.length === 0) return { kind: "none" };
  if (people.length === 1) return { kind: "matched", match: people[0] };
  return { kind: "conflict" };
}

/**
 * The local name to seed onto a new center record (docs/01 §6): when linking
 * to a match, the existing person's **actual** name — not whatever staff
 * happened to type into the form before the match was found — otherwise the
 * form's own input, which at that point *is* the brand-new `User`'s name.
 * Seeded once, at creation; editable locally and independently right after,
 * never locked (`components/center/person-fields.tsx`).
 */
export function seedLocalName(
  resolution: ContactResolution,
  formName: { firstName: string; lastName: string },
): { firstName: string; lastName: string } {
  return resolution.kind === "matched"
    ? {
        firstName: resolution.match.user.firstName,
        lastName: resolution.match.user.lastName,
      }
    : formName;
}

export type PersonInput = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  altPhone: string | null;
  locale: string;
};

/**
 * Creates a **new** person. Only called when nothing matched — the entered
 * contact becomes the global `User`'s email/phone/altPhone at this one
 * moment (the "seed"), and the caller separately writes the same values onto
 * the center-local record. Later edits at any center touch only that
 * center's local copy, never this row again (docs/01 §6).
 */
export function createPerson(
  data: PersonInput,
  tx: Prisma.TransactionClient = prisma,
): Promise<User> {
  return tx.user.create({
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      email: normalizeEmail(data.email),
      phone: normalizePhone(data.phone),
      altPhone: data.altPhone,
      locale: data.locale,
    },
  });
}

/**
 * Removes the `User` row after its last center relationship is deleted — but
 * only for someone this platform created and who exists nowhere else. A person
 * who has signed in owns their identity; a person another center still knows
 * is not ours to delete. Returns whether the row was removed.
 */
export async function deletePersonIfOrphaned(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      _count: { select: { memberships: true, studentProfiles: true } },
    },
  });

  if (!user) return false;
  if (user.authId || user.isPlatformAdmin) return false;
  if (user._count.memberships > 0 || user._count.studentProfiles > 0) {
    return false;
  }

  await prisma.user.delete({ where: { id: userId } });
  return true;
}
