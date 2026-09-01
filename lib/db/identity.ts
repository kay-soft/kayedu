import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import {
  contactMatchWhere,
  fullName,
  matchedFields,
  normalizeEmail,
  normalizePhone,
  type ContactInput,
} from "@/lib/identity";
import type { MatchCandidate } from "@/lib/validation/people";

/**
 * The global identity layer (docs/01-data-model.md §1, spec §5).
 *
 * `User` is the one table with no `centerId` — it is a person, not a tenant
 * row — so it is reached through this module rather than `scoped(ctx)`. What
 * keeps it safe is that nothing here returns tenant data: it answers "does
 * this person already exist?" and "are they already connected to *this*
 * center?", and every center-scoped read around it still goes through
 * `lib/db/scoped.ts`.
 */

/**
 * People matching the submitted contact details. Returns up to two, because a
 * form can legitimately hit two different people (this email is A's, this
 * phone is B's) — that is a conflict a human resolves, not something to merge.
 */
export async function findPeopleByContact(
  input: ContactInput,
): Promise<User[]> {
  const where = contactMatchWhere(input);
  if (!where) return [];
  return prisma.user.findMany({ where, take: 2 });
}

/** Memberships + student profiles this person holds at *other* centers. */
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
 * who they are, which field matched, and whether they are already here.
 */
export async function describeMatch(
  centerId: string,
  user: User,
  input: ContactInput,
): Promise<MatchCandidate> {
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
    email: user.email,
    phone: user.phone,
    matchedOn: matchedFields(input, user),
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
 * - `none` — nobody matches; create a new person.
 */
export type ContactResolution =
  | { kind: "none" }
  | { kind: "matched"; user: User }
  | { kind: "conflict" };

export async function resolveContact(
  input: ContactInput,
): Promise<ContactResolution> {
  const people = await findPeopleByContact(input);
  if (people.length === 0) return { kind: "none" };
  if (people.length === 1) return { kind: "matched", user: people[0] };
  return { kind: "conflict" };
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
 * Creates a person. Contact details are stored normalized so the next
 * duplicate check matches, and the unique columns are written as null rather
 * than "" — Postgres allows many nulls, and "" would collide.
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

export function updatePerson(
  userId: string,
  data: Omit<PersonInput, "locale">,
  tx: Prisma.TransactionClient = prisma,
): Promise<User> {
  return tx.user.update({
    where: { id: userId },
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      email: normalizeEmail(data.email),
      phone: normalizePhone(data.phone),
      altPhone: data.altPhone,
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
