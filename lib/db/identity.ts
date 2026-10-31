import type { Prisma, PrismaClient, User } from "@prisma/client";
// Relative imports on purpose (R6): `lib/db/teacher-membership.ts` — the one
// teacher-creation path — runs inside the class-creation transaction, and
// `npm run check:class-creation` calls it outside the Next.js runtime, so this
// module and everything it pulls in must resolve without the `@/` alias (same
// reasoning as lib/db/students.ts). The reads below take an optional client so
// that path can read through its own transaction; the default is the shared one.
import { prisma } from "./client.ts";
import {
  fullName,
  normalizeContact,
  normalizeEmail,
  type ContactInput,
  type ContactMatchField,
} from "../identity.ts";
import { normalizePhone } from "../phone.ts";
import { checkRateLimits, type RateLimitName } from "../rate-limit.ts";
import { requireEmailConfirmation } from "../auth/auth-config.ts";
import type { MatchCandidate } from "../validation/people.ts";

type Db = PrismaClient | Prisma.TransactionClient;

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

export type ContactMatch = {
  user: User;
  matchedOn: ContactMatchField[];
  /** The email matched the person's **global** `User.email` (their login). */
  globalEmail: boolean;
};

/**
 * Can staff attach a new centre record to this person (SEC-2a, D-01/D-02)?
 *
 * Only through the person's **global email** — their login credential, or the
 * email a centre typed for a person who has never signed in. Never through a
 * phone (no phone in this product is verified, D-02), and never through
 * another centre's local record (a self-registered student can write their
 * own local contact once, SEC-17). With `REQUIRE_EMAIL_CONFIRMATION=true`, an
 * email that belongs to a login must also be confirmed. Linking to a person
 * with no login exposes nothing to anyone: their own later sign-up still
 * needs a staff-approved claim (`lib/db/account-claims.ts`).
 */
export function isLinkableMatch(
  match: ContactMatch,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!match.globalEmail) return false;
  if (!match.user.authId) return true;
  return !requireEmailConfirmation(env) || match.user.emailVerifiedAt !== null;
}

/**
 * People matching the submitted contact details, searched across the global
 * `User` and every center's local `StudentProfile`/`Membership` record.
 * Returns up to two distinct people, because a form can legitimately hit two
 * different humans (this email is A's, this phone is B's) — that is a
 * conflict a human resolves, not something to merge.
 */
export async function findPeopleByContact(
  input: ContactInput,
  db: Db = prisma,
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
    db.user.findMany({ where: { OR: userOr } }),
    db.studentProfile.findMany({
      where: { OR: localOr },
      include: { user: true },
    }),
    db.membership.findMany({
      where: { OR: localOr },
      include: { user: true },
    }),
  ]);

  const byUser = new Map<
    string,
    { user: User; matchedOn: Set<ContactMatchField>; globalEmail: boolean }
  >();
  const record = (
    user: User,
    recordEmail: string | null,
    recordPhone: string | null,
    isGlobal: boolean,
  ) => {
    const existing = byUser.get(user.id);
    const matchedOn = existing?.matchedOn ?? new Set<ContactMatchField>();
    const emailHit = Boolean(email && recordEmail === email);
    if (emailHit) matchedOn.add("email");
    if (phone && recordPhone === phone) matchedOn.add("phone");
    if (matchedOn.size === 0) return;
    byUser.set(user.id, {
      user: existing?.user ?? user,
      matchedOn,
      globalEmail: (existing?.globalEmail ?? false) || (isGlobal && emailHit),
    });
  };

  for (const user of globalUsers) record(user, user.email, user.phone, true);
  for (const profile of localStudents) record(profile.user, profile.email, profile.phone, false);
  for (const membership of localTeachers) {
    record(membership.user, membership.email, membership.phone, false);
  }

  return [...byUser.values()].map(({ user, matchedOn, globalEmail }) => ({
    user,
    matchedOn: [...matchedOn],
    globalEmail,
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
  db: Db = prisma,
): Promise<number> {
  // SEC-47 / D-23 (a): only the *same organisation's* other branches. Whether
  // this person studies or works at an unrelated organisation is theirs, not
  // this centre's, to know.
  const center = await db.center.findUnique({
    where: { id: centerId },
    select: { organizationId: true },
  });
  if (!center) return 0;
  const sameOrgElsewhere = {
    userId,
    centerId: { not: centerId },
    center: { organizationId: center.organizationId },
  };
  const [memberships, profiles] = await Promise.all([
    db.membership.count({ where: sameOrgElsewhere }),
    db.studentProfile.count({ where: sameOrgElsewhere }),
  ]);
  return memberships + profiles;
}

/**
 * Does this person hold any relation inside the given centre's organisation?
 * The D-08 (b) line: a match outside it is described without a name.
 */
async function knownInOrganization(db: Db, userId: string, centerId: string): Promise<boolean> {
  const center = await db.center.findUnique({
    where: { id: centerId },
    select: { organizationId: true },
  });
  if (!center) return false;
  const inOrg = { userId, center: { organizationId: center.organizationId } };
  const [memberships, profiles] = await Promise.all([
    db.membership.count({ where: inOrg }),
    db.studentProfile.count({ where: inOrg }),
  ]);
  return memberships + profiles > 0;
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
  db: Db = prisma,
): Promise<MatchCandidate> {
  const { user, matchedOn } = match;
  const { email, phone } = normalizeContact(input);
  const [studentProfile, membership, inOrganization] = await Promise.all([
    db.studentProfile.findFirst({ where: { userId: user.id, centerId } }),
    db.membership.findFirst({ where: { userId: user.id, centerId } }),
    knownInOrganization(db, user.id, centerId),
  ]);

  let existingHere: MatchCandidate["existingHere"] = null;
  if (studentProfile) existingHere = "student";
  else if (membership) {
    existingHere = membership.role === "TEACHER" ? "teacher" : "staff";
  }

  return {
    userId: user.id,
    // SEC-11 / D-08 (b): a person known only outside this organisation is
    // described without a name — "an account with this contact exists".
    name: inOrganization ? fullName(user) : null,
    email,
    phone,
    matchedOn,
    existingHere,
    linkable: isLinkableMatch(match),
    ...(studentProfile ? { existingProfileId: studentProfile.id } : {}),
  };
}

/**
 * Resolves a person for an "add teacher / add student" submission — and for
 * the phone lookup, which runs the very same thing (spec §5.1, M18).
 *
 * - `matched` — one person staff may act on: someone they may **link** to
 *   (`isLinkableMatch` — a global email, never a phone), or someone who
 *   already holds the relationship being added **here** (refused as a
 *   duplicate, never linked). The caller shows the match panel and only
 *   links once staff confirm "Use this person" (never a silent merge, spec §5).
 * - `conflict` — two such people. Merging identities is a manual, audited
 *   admin action (docs/02 §3).
 * - `none` — nobody staff may link to: create a new person. `others` carries
 *   every other contact hit (a phone, another centre's local record) — never
 *   linkable, used only to *refuse* (a staff member's or administrator's
 *   phone in the inline new-teacher flow).
 * - `rateLimited` — the lookup budget is spent (SEC-11 / D-08). Every path
 *   that can reveal who owns a contact goes through here, so the limit — per
 *   staff member and per centre, in the shared store — covers all of them.
 */
export type ContactResolution =
  | { kind: "none"; others: ContactMatch[] }
  | { kind: "matched"; match: ContactMatch; others: ContactMatch[] }
  | { kind: "conflict" }
  | { kind: "rateLimited" };

/** Who is looking, where, and which relationship they are adding. */
export type LookupContext = {
  centerId: string;
  actorUserId: string | null;
  adding: "student" | "teacher";
};

export async function resolveContact(
  context: LookupContext,
  input: ContactInput,
  db: Db = prisma,
): Promise<ContactResolution> {
  const { email, phone } = normalizeContact(input);
  if (!email && !phone) return { kind: "none", others: [] };

  const limits: { name: RateLimitName; key: string }[] = [
    { name: "identityLookupPerCenter", key: context.centerId },
  ];
  if (context.actorUserId) {
    limits.unshift({ name: "identityLookupPerUser", key: context.actorUserId });
  }
  if (!(await checkRateLimits(limits))) return { kind: "rateLimited" };

  const people = await findPeopleByContact(input, db);
  if (people.length === 0) return { kind: "none", others: [] };

  const ids = people.map((person) => person.user.id);
  const here =
    context.adding === "student"
      ? await db.studentProfile.findMany({
          where: { centerId: context.centerId, userId: { in: ids } },
          select: { userId: true },
        })
      : await db.membership.findMany({
          where: { centerId: context.centerId, userId: { in: ids }, role: "TEACHER" },
          select: { userId: true },
        });
  const alreadyHere = new Set(here.map((row) => row.userId));

  const actionable = people.filter(
    (person) => isLinkableMatch(person) || alreadyHere.has(person.user.id),
  );
  const others = people.filter((person) => !actionable.includes(person));
  if (actionable.length === 0) return { kind: "none", others };
  if (actionable.length === 1) return { kind: "matched", match: actionable[0], others };
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
  described?: Pick<MatchCandidate, "name"> | null,
): { firstName: string; lastName: string } {
  // A match described without a name (D-08 (b): known only outside this
  // organisation) never leaks it through the seeded record either.
  if (resolution.kind !== "matched" || described?.name === null) return formName;
  return {
    firstName: resolution.match.user.firstName,
    lastName: resolution.match.user.lastName,
  };
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
export async function createPerson(
  data: PersonInput,
  tx: Db = prisma,
): Promise<User> {
  // A contact another person already holds globally is not copied onto the
  // new `User` (SEC-2a): it was not a link (a phone never is, and an email may
  // not be — `isLinkableMatch`), so it stays only on this centre's own local
  // record, and nobody's global contact is squatted or blocked by it.
  const email = normalizeEmail(data.email);
  const phone = normalizePhone(data.phone);
  const [emailTaken, phoneTaken] = await Promise.all([
    email ? tx.user.findUnique({ where: { email }, select: { id: true } }) : null,
    phone ? tx.user.findUnique({ where: { phone }, select: { id: true } }) : null,
  ]);
  return tx.user.create({
    data: {
      firstName: data.firstName,
      lastName: data.lastName,
      email: emailTaken ? null : email,
      phone: phoneTaken ? null : phone,
      altPhone: normalizePhone(data.altPhone),
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

/** People's global names by id (a fallback when no centre-local record exists yet). */
export function usersByIds(db: Db, ids: string[]) {
  return db.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
}
