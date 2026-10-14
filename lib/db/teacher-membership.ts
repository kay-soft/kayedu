import type { Prisma, PrismaClient, Role } from "@prisma/client";

// Relative imports on purpose (R6): `npm run check:class-creation` calls this
// module — and the class-creation transaction that embeds it — outside the
// Next.js runtime, the same reason lib/db/class-sessions.ts is written this way.
import {
  createPerson,
  describeMatch,
  resolveContact,
  seedLocalName,
  type PersonInput,
} from "./identity.ts";
import { WRITE_TRANSACTION_OPTIONS } from "./session-lifecycle.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";
import type { MatchCandidate } from "../validation/people.ts";

/**
 * **The one place a teacher is added to a centre** (CLAUDE.md rule 4; spec §5
 * "Identity & duplicates"; R6). The Add teacher dialog's `createTeacherAction`
 * and the class dialog's "New teacher" (`createClassWithNewTeacher`) both call
 * `addTeacherMembership`; neither re-implements it.
 *
 * It resolves the typed contact against the global identity:
 * - **nobody matches** → a new `User` (seeding its contact once, docs/01 §6)
 *   and this centre's `Membership`, which owns the centre-local name/contact;
 * - **one person matches** → nothing is written until the caller comes back
 *   with `linkUserId` equal to that person ("Use this person" — never a
 *   silent merge); then a **new membership** is attached to the existing
 *   user, never a second `User`;
 * - **the email and the phone belong to two people** → refused (merging is a
 *   manual, audited admin action).
 *
 * It runs on the **caller's transaction client**, so a caller can put it in
 * the same transaction as other writes (the class dialog does) and every row
 * it writes — `User`, `Membership`, `AuditLog` — commits or rolls back with
 * them. All refusals happen before the first write.
 */

type Tx = Prisma.TransactionClient;

const TEACHER: Role = "TEACHER";

export type TeacherRefusal =
  /** The email and the phone belong to two different people. */
  | "contactConflict"
  /** The contact-lookup budget is spent (SEC-11 / D-08). */
  | "rateLimited"
  /** `linkUserId` was posted but nobody matches any more. */
  | "matchGone"
  /** They already teach at this centre — select them instead. */
  | "alreadyTeacher"
  /** The contact is taken (a unique-constraint race). */
  | "contactInUse"
  /** Inline flow only: an owner/manager/receptionist/accountant here. */
  | "staffMember"
  /** Inline flow only: a platform administrator. */
  | "privilegedPerson";

export type TeacherMembershipResult =
  | {
      ok: true;
      membershipId: string;
      /** The teacher's `User` id — what `ClassGroup.teacherId` stores. */
      userId: string;
      outcome: "created" | "linked" | "reactivated";
    }
  | { ok: false; error: TeacherRefusal | "matchFound"; match?: MatchCandidate };

export type TeacherMembershipOptions = {
  actorUserId: string | null;
  /** Set only after staff confirmed the match panel ("Use this person"). */
  linkUserId: string | null;
  /** Where the add came from — recorded on the audit row. */
  via: "teacher.add" | "class.create";
  /**
   * Refuse a match who holds another role here or is a platform
   * administrator. The class dialog sets it (it cannot become a hidden way to
   * give someone a second role); the Add teacher dialog, which shows the
   * match panel with the "already a staff member" notice, does not.
   */
  refusePrivileged: boolean;
};

/**
 * The inline flow's refusal for a contact that belongs to a platform
 * administrator or to someone holding a non-teacher role at this centre.
 */
async function privilegedRefusal(
  tx: Tx,
  centerId: string,
  user: { id: string; isPlatformAdmin: boolean },
): Promise<"privilegedPerson" | "staffMember" | null> {
  if (user.isPlatformAdmin) return "privilegedPerson";
  const otherRole = await tx.membership.findFirst({
    where: scopedWhere(centerId, { userId: user.id, role: { not: TEACHER } }),
    select: { id: true },
  });
  return otherRole ? "staffMember" : null;
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

const fail = (error: TeacherRefusal | "matchFound", match?: MatchCandidate) =>
  ({ ok: false, error, ...(match ? { match } : {}) }) as const;

export async function addTeacherMembership(
  tx: Tx,
  centerId: string,
  input: PersonInput,
  options: TeacherMembershipOptions,
): Promise<TeacherMembershipResult> {
  const { email, phone, altPhone } = input;
  const contact = { email, phone };
  const resolution = await resolveContact(
    { centerId, actorUserId: options.actorUserId, adding: "teacher" },
    contact,
    tx,
  );

  if (resolution.kind === "rateLimited") return fail("rateLimited");
  if (resolution.kind === "conflict") return fail("contactConflict");

  // Inline flow (class dialog): never a hidden way to give someone a second
  // role. Checked against **every** contact hit — a phone included — because
  // refusing reveals nothing it could link (SEC-2a keeps phones out of links,
  // not out of refusals).
  if (options.refusePrivileged) {
    const hits = resolution.kind === "matched" ? [resolution.match, ...resolution.others] : resolution.others;
    for (const hit of hits) {
      const refusal = await privilegedRefusal(tx, centerId, hit.user);
      if (refusal) return fail(refusal, await describeMatch(centerId, hit, contact, tx));
    }
  }

  const matchedDescription =
    resolution.kind === "matched" ? await describeMatch(centerId, resolution.match, contact, tx) : null;

  // The name to seed onto this centre's record: the existing person's real
  // name when linking to a match (unless masked, D-08), or the form's own
  // input for a brand-new person (docs/01 §6) — editable here either way.
  const name = seedLocalName(
    resolution,
    { firstName: input.firstName, lastName: input.lastName },
    matchedDescription,
  );
  const local = { firstName: name.firstName, lastName: name.lastName, email, phone, altPhone };

  if (resolution.kind === "none") {
    if (options.linkUserId) return fail("matchGone");
    const person = await createPerson(input, tx);
    const membership = await tx.membership.create({
      data: scopedData(centerId, { userId: person.id, role: TEACHER, joinedAt: new Date(), ...local }),
    });
    await tx.auditLog.create({
      data: {
        centerId,
        actorUserId: options.actorUserId,
        action: "membership.create",
        entityType: "Membership",
        entityId: membership.id,
        after: { role: "TEACHER", via: options.via, linked: false },
      },
    });
    return { ok: true, membershipId: membership.id, userId: person.id, outcome: "created" };
  }

  // Someone matched. Show them before doing anything — "this person already
  // exists", never a silent merge (spec §5).
  const matched = resolution.match.user;
  const match = matchedDescription!;

  if (options.linkUserId !== matched.id) return fail("matchFound", match);

  if (match.existingHere === "teacher" || !match.linkable) return fail("alreadyTeacher", match);

  // Re-activating a former teacher is the same membership coming back, not a
  // second one — Membership is unique on (userId, centerId, role). Either way,
  // this centre's own contact record is written fresh from the form.
  const existing = await tx.membership.findFirst({
    where: scopedWhere(centerId, { userId: matched.id, role: TEACHER }),
  });
  if (existing) {
    await tx.membership.updateMany({
      where: scopedWhere(centerId, { id: existing.id }),
      data: { active: true, joinedAt: existing.joinedAt ?? new Date(), ...local },
    });
    await tx.auditLog.create({
      data: {
        centerId,
        actorUserId: options.actorUserId,
        action: "membership.activate",
        entityType: "Membership",
        entityId: existing.id,
        before: { active: existing.active },
        after: { active: true, via: options.via, linked: true },
      },
    });
    return { ok: true, membershipId: existing.id, userId: matched.id, outcome: "reactivated" };
  }

  const membership = await tx.membership.create({
    data: scopedData(centerId, { userId: matched.id, role: TEACHER, joinedAt: new Date(), ...local }),
  });
  await tx.auditLog.create({
    data: {
      centerId,
      actorUserId: options.actorUserId,
      action: "membership.create",
      entityType: "Membership",
      entityId: membership.id,
      after: { role: "TEACHER", via: options.via, linked: true, matchedOn: match.matchedOn },
    },
  });
  return { ok: true, membershipId: membership.id, userId: matched.id, outcome: "linked" };
}

/**
 * `addTeacherMembership` in its own transaction — the Add teacher dialog's
 * path. A unique-constraint race on the contact comes back as `contactInUse`.
 */
export async function createTeacherMembership(
  db: PrismaClient,
  centerId: string,
  input: PersonInput,
  options: TeacherMembershipOptions,
): Promise<TeacherMembershipResult> {
  try {
    return await db.$transaction((tx) => addTeacherMembership(tx, centerId, input, options), WRITE_TRANSACTION_OPTIONS);
  } catch (error) {
    if (isUniqueViolation(error)) return fail("contactInUse");
    throw error;
  }
}
