import { createHash, randomInt } from "node:crypto";
import type {
  FamilyInvitationSource,
  FamilyLinkSource,
  Prisma,
  PrismaClient,
} from "@prisma/client";
// Relative imports on purpose — `npm run check:parent` and `check:security`
// exercise this module directly, outside the Next.js runtime (same reasoning
// as lib/db/student-portal.ts and lib/db/reservations.ts).
import { FAMILY_CODE_ALPHABET, FAMILY_CODE_LENGTH, normalizeFamilyCode } from "../family-code.ts";
import { normalizePhone } from "../phone.ts";
import { checkRateLimits } from "../rate-limit.ts";
import { ACCESSIBLE_CENTER } from "./platform.ts";
import { writeAuditRow } from "./audit-row.ts";

/**
 * Family links (F3 — OD-6 decided; docs/00-master-product-spec.md §5.1
 * "Parent role & portal", docs/01-data-model.md "FamilyLink"). The whole
 * read/write surface of parent access, and every rule lives here, on the
 * server, never in a form:
 *
 * 1. **Access needs a secret, never a phone.** A `FamilyLink` is created only
 *    by accepting a one-time code (`acceptFamilyCode`). Nothing matches,
 *    links or refuses on a phone; a declared parent phone is shown to staff,
 *    never used as a key.
 * 2. **Codes are stored as hashes only** (sha256 + a two-character hint),
 *    shown in full once, single use (a conditional PENDING → ACCEPTED
 *    update), revocable, with no time limit.
 * 3. **A student account can't be a parent** — the "hand a code to a
 *    classmate" case. Platform admins are refused too. Staff and teachers
 *    may be parents (supersedes the M16 privileged-phone refusal).
 * 4. **Slots** — at most 3 per student (active links + pending invitations),
 *    3 active parents per student and 10 children per parent; the student
 *    is serialized by an advisory lock so parallel requests cannot race past.
 * 5. **Only explicit, audited revocation ends a link** — by the branch (with
 *    a reason, `parent.link.manage`), the parent, or a platform admin. Never
 *    by the student (a minor can't cut off their parent).
 * 6. **The parent portal reads only through `activeChildLinks`** — ACTIVE
 *    links, and per child only the active `StudentProfile`s at accessible
 *    centres (D-10), read with the student portal's own scoped functions.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

// ── Codes ────────────────────────────────────────────────────────────────

export { FAMILY_CODE_ALPHABET, FAMILY_CODE_LENGTH, normalizeFamilyCode };

export const FAMILY_LIMITS = {
  /** Active links + pending invitations, per student. */
  slotsPerStudent: 3,
  parentsPerStudent: 3,
  childrenPerParent: 10,
} as const;

/** A fresh code, 8 symbols, uniformly drawn with the CSPRNG. */
export function generateFamilyCode(): string {
  let code = "";
  for (let index = 0; index < FAMILY_CODE_LENGTH; index += 1) {
    code += FAMILY_CODE_ALPHABET[randomInt(FAMILY_CODE_ALPHABET.length)];
  }
  return code;
}

/** The only form of a code the database ever holds. */
export function hashFamilyCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function familyCodeHint(code: string): string {
  return code.slice(-2);
}

// ── Shared reads ─────────────────────────────────────────────────────────

const PENDING = "PENDING" as const;
const ACTIVE = "ACTIVE" as const;

/** Serializes every slot-counting write for one student. */
async function lockStudent(tx: Tx, studentUserId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`family-student:${studentUserId}`}, 0))`;
}

async function lockParent(tx: Tx, parentUserId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`family-parent:${parentUserId}`}, 0))`;
}

/** Active links + pending invitations (any source) — the 3-slot count. */
export async function familySlotsInUse(db: Db, studentUserId: string): Promise<number> {
  const [links, invitations] = await Promise.all([
    db.familyLink.count({ where: { studentUserId, status: ACTIVE } }),
    db.familyInvitation.count({ where: { studentUserId, status: PENDING } }),
  ]);
  return links + invitations;
}

/**
 * Is this account a student anywhere? A StudentProfile at any branch (active
 * or not), a pending code issued for them, or a family link where they are
 * the child (an accepted code always made one). Such an account can never
 * accept a code (a parent needs their own parent account). A cancelled
 * invitation does not count, so a parent who pressed "Invite a parent" by
 * mistake can undo it. **F4:** an account that said it was signing up as a
 * STUDENT counts too — before it has any profile, a "student" must not be
 * able to accept a classmate's code. That is a refusal, never a grant: the
 * intent opens no door anywhere else.
 */
export async function isStudentAccount(db: Db, userId: string): Promise<boolean> {
  const [profile, invitation, asChild, declared] = await Promise.all([
    db.studentProfile.findFirst({ where: { userId }, select: { id: true } }),
    db.familyInvitation.findFirst({ where: { studentUserId: userId, status: PENDING }, select: { id: true } }),
    db.familyLink.findFirst({ where: { studentUserId: userId }, select: { id: true } }),
    db.user.findFirst({ where: { id: userId, signupIntent: "STUDENT" }, select: { id: true } }),
  ]);
  return Boolean(profile || invitation || asChild || declared);
}

/** A parent account (one active child or more) cannot invite parents of its own. */
async function hasActiveChildren(db: Db, userId: string): Promise<boolean> {
  return (await db.familyLink.count({ where: { parentUserId: userId, status: ACTIVE } })) > 0;
}

async function createInvitation(
  tx: Tx,
  data: {
    studentUserId: string;
    source: FamilyInvitationSource;
    createdBy: string;
    issuingCenterId?: string | null;
    declaredParentFirstName?: string | null;
    declaredParentLastName?: string | null;
    declaredParentPhone?: string | null;
  },
): Promise<{ id: string; code: string }> {
  // 31^8 codes: a collision is ~never, but cheap to rule out before the insert.
  let code = generateFamilyCode();
  while (await tx.familyInvitation.findUnique({ where: { codeHash: hashFamilyCode(code) }, select: { id: true } })) {
    code = generateFamilyCode();
  }
  const row = await tx.familyInvitation.create({
    data: {
      ...data,
      declaredParentPhone: normalizePhone(data.declaredParentPhone),
      codeHash: hashFamilyCode(code),
      codeHint: familyCodeHint(code),
    },
    select: { id: true },
  });
  return { id: row.id, code };
}

export type FamilyError =
  | "notFound"
  | "forbidden"
  | "notAStudent"
  | "slotsFull"
  | "rateLimited"
  | "invalidCode"
  | "ownCode"
  | "studentAccount"
  | "platformAdmin"
  | "alreadyLinked"
  | "parentLimit"
  | "childLimit"
  | "reasonRequired";

export type IssuedCode = { ok: true; code: string; invitationId: string; studentUserId: string };
export type FamilyRefusal = { ok: false; error: FamilyError };

// ── The student's own invitations (Account → Family) ────────────────────────

/**
 * "Invite a parent": a PENDING invitation carrying the parent the student
 * declared, and its code — returned once, never stored. Refused for a parent
 * account and a platform admin, and once the student's 3 slots are in use.
 */
export async function issueStudentInvitation(
  db: PrismaClient,
  input: {
    studentUserId: string;
    declaredParentFirstName: string;
    declaredParentLastName: string;
    declaredParentPhone: string | null;
  },
): Promise<IssuedCode | FamilyRefusal> {
  return db.$transaction(async (tx) => {
    const student = await tx.user.findUnique({ where: { id: input.studentUserId }, select: { isPlatformAdmin: true } });
    if (!student) return { ok: false, error: "notFound" } as const;
    if (student.isPlatformAdmin || (await hasActiveChildren(tx, input.studentUserId))) {
      return { ok: false, error: "notAStudent" } as const;
    }
    await lockStudent(tx, input.studentUserId);
    if ((await familySlotsInUse(tx, input.studentUserId)) >= FAMILY_LIMITS.slotsPerStudent) {
      return { ok: false, error: "slotsFull" } as const;
    }
    const created = await createInvitation(tx, {
      studentUserId: input.studentUserId,
      source: "STUDENT_INVITE",
      createdBy: input.studentUserId,
      declaredParentFirstName: input.declaredParentFirstName,
      declaredParentLastName: input.declaredParentLastName,
      declaredParentPhone: input.declaredParentPhone,
    });
    return { ok: true, code: created.code, invitationId: created.id, studentUserId: input.studentUserId } as const;
  }, TRANSACTION_OPTIONS);
}

/**
 * "New code" on one of the student's own pending invitations: the old code
 * is revoked and a new one takes the same slot and the same declared parent.
 */
export async function regenerateStudentInvitation(
  db: PrismaClient,
  input: { studentUserId: string; invitationId: string },
): Promise<IssuedCode | FamilyRefusal> {
  return db.$transaction(async (tx) => {
    await lockStudent(tx, input.studentUserId);
    const old = await tx.familyInvitation.findFirst({
      where: { id: input.invitationId, studentUserId: input.studentUserId, source: "STUDENT_INVITE", status: PENDING },
    });
    if (!old) return { ok: false, error: "notFound" } as const;
    const revoked = await tx.familyInvitation.updateMany({
      where: { id: old.id, status: PENDING },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    if (revoked.count !== 1) return { ok: false, error: "notFound" } as const;
    const created = await createInvitation(tx, {
      studentUserId: old.studentUserId,
      source: "STUDENT_INVITE",
      createdBy: input.studentUserId,
      declaredParentFirstName: old.declaredParentFirstName,
      declaredParentLastName: old.declaredParentLastName,
      declaredParentPhone: old.declaredParentPhone,
    });
    return { ok: true, code: created.code, invitationId: created.id, studentUserId: old.studentUserId } as const;
  }, TRANSACTION_OPTIONS);
}

/** The student cancels one of their own pending invitations (never a branch's code, never a link). */
export async function revokeStudentInvitation(
  db: Db,
  input: { studentUserId: string; invitationId: string },
): Promise<{ ok: true } | FamilyRefusal> {
  const revoked = await db.familyInvitation.updateMany({
    where: { id: input.invitationId, studentUserId: input.studentUserId, source: "STUDENT_INVITE", status: PENDING },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  return revoked.count === 1 ? { ok: true } : { ok: false, error: "notFound" };
}

// ── The branch's printed code (/students/[id]) ──────────────────────────────

/**
 * "Generate parent code" for a student at this branch — works for a
 * staff-created student with no login, since the code targets the student's
 * global User. One live code per (student, branch): a previous one is revoked
 * first. Audited `family.code.issue` (ids only), in the same transaction.
 * The caller has checked `parent.link.manage`; the profile is looked up by
 * `centerId`, so another branch's student id is `notFound`.
 */
export async function issueBranchCode(
  db: PrismaClient,
  input: { centerId: string; studentProfileId: string; actorUserId: string },
): Promise<IssuedCode | FamilyRefusal> {
  return db.$transaction(async (tx) => {
    const profile = await tx.studentProfile.findFirst({
      where: { id: input.studentProfileId, centerId: input.centerId },
      select: { id: true, userId: true },
    });
    if (!profile) return { ok: false, error: "notFound" } as const;
    await lockStudent(tx, profile.userId);
    const replaced = await tx.familyInvitation.updateMany({
      where: { studentUserId: profile.userId, issuingCenterId: input.centerId, source: "CENTER_CODE", status: PENDING },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    if ((await familySlotsInUse(tx, profile.userId)) >= FAMILY_LIMITS.slotsPerStudent) {
      // Nothing is half-done: the revocation above rolls back with this refusal.
      throw new SlotsFullRollback();
    }
    const created = await createInvitation(tx, {
      studentUserId: profile.userId,
      source: "CENTER_CODE",
      createdBy: input.actorUserId,
      issuingCenterId: input.centerId,
    });
    await writeAuditRow(tx, {
      centerId: input.centerId,
      actorUserId: input.actorUserId,
      action: "family.code.issue",
      entityType: "FamilyInvitation",
      entityId: created.id,
      after: { source: "CENTER_CODE", studentProfileId: profile.id, replacedCount: replaced.count },
    });
    return { ok: true, code: created.code, invitationId: created.id, studentUserId: profile.userId } as const;
  }, TRANSACTION_OPTIONS).catch((error: unknown) => {
    if (error instanceof SlotsFullRollback) return { ok: false, error: "slotsFull" } as const;
    throw error;
  });
}

class SlotsFullRollback extends Error {}

/** Cancels this branch's live code for a student (audited `family.code.revoke`). */
export async function revokeBranchCode(
  db: PrismaClient,
  input: { centerId: string; studentProfileId: string; actorUserId: string },
): Promise<{ ok: true } | FamilyRefusal> {
  return db.$transaction(async (tx) => {
    const profile = await tx.studentProfile.findFirst({
      where: { id: input.studentProfileId, centerId: input.centerId },
      select: { id: true, userId: true },
    });
    if (!profile) return { ok: false, error: "notFound" } as const;
    const pending = await tx.familyInvitation.findFirst({
      where: { studentUserId: profile.userId, issuingCenterId: input.centerId, source: "CENTER_CODE", status: PENDING },
      select: { id: true },
    });
    if (!pending) return { ok: false, error: "notFound" } as const;
    const revoked = await tx.familyInvitation.updateMany({
      where: { id: pending.id, status: PENDING },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    if (revoked.count !== 1) return { ok: false, error: "notFound" } as const;
    await writeAuditRow(tx, {
      centerId: input.centerId,
      actorUserId: input.actorUserId,
      action: "family.code.revoke",
      entityType: "FamilyInvitation",
      entityId: pending.id,
      after: { status: "REVOKED", studentProfileId: profile.id },
    });
    return { ok: true } as const;
  }, TRANSACTION_OPTIONS);
}

// ── Accepting a code (/family/join, Account → Family) ───────────────────────

export type AcceptResult = { ok: true; linkId: string; studentUserId: string } | FamilyRefusal;

/**
 * Accept a code as the signed-in `acceptorUserId`. Rate-limited per account
 * and per client IP **before** anything is looked up (a wrong guess counts).
 * The account-level refusals (platform admin, student account) are answered
 * whatever the code, so a student cannot use this to learn which codes are
 * live; "your own code" is told apart only for the code's own student.
 * Then one transaction: the student and the parent are locked, the limits
 * re-counted, the invitation flips PENDING → ACCEPTED **conditionally** (of
 * two accepts racing on one code exactly one wins; the other is
 * `invalidCode`), the link becomes ACTIVE (a previously REVOKED row for the
 * same pair is re-activated), and `family.link.create` is audited, ids only.
 */
export async function acceptFamilyCode(
  db: PrismaClient,
  input: { acceptorUserId: string; code: unknown; ip: string },
): Promise<AcceptResult> {
  const allowed = await checkRateLimits([
    { name: "familyJoinPerUser", key: input.acceptorUserId },
    { name: "familyJoinPerIp", key: input.ip },
  ]);
  if (!allowed) return { ok: false, error: "rateLimited" };

  const acceptor = await db.user.findUnique({ where: { id: input.acceptorUserId }, select: { id: true, isPlatformAdmin: true } });
  if (!acceptor) return { ok: false, error: "forbidden" };
  if (acceptor.isPlatformAdmin) return { ok: false, error: "platformAdmin" };

  const code = normalizeFamilyCode(input.code);
  const invitation = code
    ? await db.familyInvitation.findUnique({ where: { codeHash: hashFamilyCode(code) } })
    : null;
  const live = invitation?.status === PENDING ? invitation : null;

  if (live && live.studentUserId === acceptor.id) return { ok: false, error: "ownCode" };
  if (await isStudentAccount(db, acceptor.id)) return { ok: false, error: "studentAccount" };
  if (!live) return { ok: false, error: "invalidCode" };

  return db.$transaction(async (tx) => {
    // Always student first, then parent — the one lock order in this module.
    await lockStudent(tx, live.studentUserId);
    await lockParent(tx, acceptor.id);

    const existing = await tx.familyLink.findUnique({
      where: { parentUserId_studentUserId: { parentUserId: acceptor.id, studentUserId: live.studentUserId } },
      select: { id: true, status: true },
    });
    if (existing?.status === ACTIVE) return { ok: false, error: "alreadyLinked" } as const;
    const [parents, children] = await Promise.all([
      tx.familyLink.count({ where: { studentUserId: live.studentUserId, status: ACTIVE } }),
      tx.familyLink.count({ where: { parentUserId: acceptor.id, status: ACTIVE } }),
    ]);
    if (parents >= FAMILY_LIMITS.parentsPerStudent) return { ok: false, error: "parentLimit" } as const;
    if (children >= FAMILY_LIMITS.childrenPerParent) return { ok: false, error: "childLimit" } as const;

    const now = new Date();
    const claimed = await tx.familyInvitation.updateMany({
      where: { id: live.id, status: PENDING },
      data: { status: "ACCEPTED", acceptedBy: acceptor.id, acceptedAt: now },
    });
    if (claimed.count !== 1) return { ok: false, error: "invalidCode" } as const;

    const source: FamilyLinkSource = live.source;
    const link = existing
      ? await tx.familyLink.update({
          where: { id: existing.id },
          data: {
            status: ACTIVE,
            source,
            invitationId: live.id,
            createdAt: now,
            revokedAt: null,
            revokedBy: null,
            revokedReason: null,
          },
          select: { id: true },
        })
      : await tx.familyLink.create({
          data: { parentUserId: acceptor.id, studentUserId: live.studentUserId, status: ACTIVE, source, invitationId: live.id },
          select: { id: true },
        });

    await writeAuditRow(tx, {
      centerId: live.issuingCenterId,
      actorUserId: acceptor.id,
      action: "family.link.create",
      entityType: "FamilyLink",
      entityId: link.id,
      after: { status: ACTIVE, source, invitationId: live.id, relinked: Boolean(existing) },
    });
    return { ok: true, linkId: link.id, studentUserId: live.studentUserId } as const;
  }, TRANSACTION_OPTIONS);
}

// ── Revocation ──────────────────────────────────────────────────────────────

export type RevokeLinkInput =
  /** The parent unlinks themself (Account → Family). */
  | { by: "parent"; linkId: string; actorUserId: string }
  /** Branch staff with `parent.link.manage`, from the student's page — a reason is required. */
  | { by: "branch"; linkId: string; actorUserId: string; centerId: string; studentUserId: string; reason: string }
  /** A platform admin (no screen yet — docs/05 backlog). */
  | { by: "admin"; linkId: string; actorUserId: string; reason?: string | null };

/**
 * Ends an ACTIVE link — final for the code it stood on; relinking needs a new
 * code. There is **no student path**: the parent path is keyed on the link's
 * own parent, the branch path on a student profile at that branch, the admin
 * path on the platform flag. Audited `family.link.revoke` in the same
 * transaction (ids only; the branch's reason lives on the link). Reads stop
 * at once: `activeChildLinks` reads ACTIVE only.
 */
export async function revokeFamilyLink(db: PrismaClient, input: RevokeLinkInput): Promise<{ ok: true } | FamilyRefusal> {
  const reason = input.by === "parent" ? null : input.reason?.trim() || null;
  if (input.by === "branch" && !reason) return { ok: false, error: "reasonRequired" };
  if (input.by === "admin") {
    const actor = await db.user.findUnique({ where: { id: input.actorUserId }, select: { isPlatformAdmin: true } });
    if (!actor?.isPlatformAdmin) return { ok: false, error: "forbidden" };
  }

  const where: Prisma.FamilyLinkWhereInput =
    input.by === "parent"
      ? { id: input.linkId, parentUserId: input.actorUserId, status: ACTIVE }
      : input.by === "branch"
        ? {
            id: input.linkId,
            status: ACTIVE,
            studentUserId: input.studentUserId,
            studentUser: { studentProfiles: { some: { centerId: input.centerId } } },
          }
        : { id: input.linkId, status: ACTIVE };

  return db.$transaction(async (tx) => {
    const revoked = await tx.familyLink.updateMany({
      where,
      data: { status: "REVOKED", revokedAt: new Date(), revokedBy: input.actorUserId, revokedReason: reason },
    });
    if (revoked.count !== 1) return { ok: false, error: "notFound" } as const;
    await writeAuditRow(tx, {
      centerId: input.by === "branch" ? input.centerId : null,
      actorUserId: input.actorUserId,
      action: "family.link.revoke",
      entityType: "FamilyLink",
      entityId: input.linkId,
      before: { status: ACTIVE },
      after: { status: "REVOKED", by: input.by },
    });
    return { ok: true } as const;
  }, TRANSACTION_OPTIONS);
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The **only** read any parent-portal page may build on: the parent's ACTIVE
 * links, each with the child's account and only the child's **active**
 * profiles at **accessible** centres (D-10: a suspended/archived centre or a
 * deactivated profile disappears). A pending invitation is not a link and
 * contributes nothing; a revoked link reads as nothing from the next request.
 */
export function activeChildLinks(db: Db, parentUserId: string) {
  return db.familyLink.findMany({
    where: { parentUserId, status: ACTIVE },
    orderBy: { createdAt: "asc" },
    include: {
      studentUser: {
        include: {
          studentProfiles: {
            where: { active: true, center: ACCESSIBLE_CENTER },
            orderBy: { createdAt: "asc" },
            include: { center: true },
          },
        },
      },
    },
  });
}

/** How a link came to exist, as the branch reads it. */
export type LinkOrigin = "childInvite" | "thisBranch" | "otherBranch" | "legacy";

export type BranchFamilyAccess = {
  links: {
    id: string;
    parentFirstName: string;
    parentLastName: string;
    origin: LinkOrigin;
    since: Date;
    /** The parent the child declared on the invitation, when there is one. */
    declaredParentName: string | null;
  }[];
  /** This branch's live code for the student, if one is waiting. */
  pendingCode: { hint: string; createdAt: Date } | null;
  slotsUsed: number;
};

/**
 * The staff "Parent access" card: every ACTIVE parent of the student whose
 * profile is at `centerId` (another branch's profile id → null). The parent
 * is shown by their account name only — no parent email or phone.
 */
export async function familyAccessForStudent(
  db: Db,
  centerId: string,
  studentProfileId: string,
): Promise<BranchFamilyAccess | null> {
  const profile = await db.studentProfile.findFirst({ where: { id: studentProfileId, centerId }, select: { userId: true } });
  if (!profile) return null;
  const [links, pending, slotsUsed] = await Promise.all([
    db.familyLink.findMany({
      where: { studentUserId: profile.userId, status: ACTIVE },
      orderBy: { createdAt: "asc" },
      include: {
        parentUser: { select: { firstName: true, lastName: true } },
        invitation: {
          select: { source: true, issuingCenterId: true, declaredParentFirstName: true, declaredParentLastName: true },
        },
      },
    }),
    db.familyInvitation.findFirst({
      where: { studentUserId: profile.userId, issuingCenterId: centerId, source: "CENTER_CODE", status: PENDING },
      select: { codeHint: true, createdAt: true },
    }),
    familySlotsInUse(db, profile.userId),
  ]);
  return {
    links: links.map((link) => ({
      id: link.id,
      parentFirstName: link.parentUser.firstName,
      parentLastName: link.parentUser.lastName,
      origin:
        link.source === "LEGACY_VERIFIED"
          ? "legacy"
          : link.source === "STUDENT_INVITE"
            ? "childInvite"
            : link.invitation?.issuingCenterId === centerId
              ? "thisBranch"
              : "otherBranch",
      since: link.createdAt,
      declaredParentName:
        [link.invitation?.declaredParentFirstName, link.invitation?.declaredParentLastName].filter(Boolean).join(" ") ||
        null,
    })),
    pendingCode: pending ? { hint: pending.codeHint, createdAt: pending.createdAt } : null,
    slotsUsed,
  };
}

export type AccountFamily = {
  /** Which Family views the account page offers this person. */
  showParentView: boolean;
  showStudentView: boolean;
  /** As a parent: ACTIVE links to children (account name, linked date, branch names). */
  children: { linkId: string; firstName: string; lastName: string; since: Date; branches: string[] }[];
  /** As a student: ACTIVE parents (account name) — the student cannot remove them. */
  parents: { linkId: string; firstName: string; lastName: string; since: Date }[];
  /** As a student: pending codes (their own invitations and any branch's). */
  invitations: {
    id: string;
    source: FamilyInvitationSource;
    hint: string;
    createdAt: Date;
    declaredParentName: string | null;
    branchName: string | null;
  }[];
  slotsUsed: number;
};

/**
 * Account → Family for the signed-in person. A platform admin gets neither
 * view. A student account gets the student view; a parent, a staff member or
 * a teacher the parent view; a brand-new account with no relation anywhere
 * gets both, since nothing says yet which one they are.
 */
export async function familyForAccount(db: Db, userId: string): Promise<AccountFamily> {
  const accessible = ACCESSIBLE_CENTER;
  const [user, childLinks, parentRows, invitations, studentAccount, membership] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } }),
    db.familyLink.findMany({
      where: { parentUserId: userId, status: ACTIVE },
      orderBy: { createdAt: "asc" },
      include: {
        studentUser: {
          select: {
            firstName: true,
            lastName: true,
            studentProfiles: { where: { active: true, center: accessible }, select: { center: { select: { name: true } } } },
          },
        },
      },
    }),
    db.familyLink.findMany({
      where: { studentUserId: userId, status: ACTIVE },
      orderBy: { createdAt: "asc" },
      include: { parentUser: { select: { firstName: true, lastName: true } } },
    }),
    db.familyInvitation.findMany({
      where: { studentUserId: userId, status: PENDING },
      orderBy: { createdAt: "asc" },
      include: { issuingCenter: { select: { name: true } } },
    }),
    isStudentAccount(db, userId),
    db.membership.findFirst({ where: { userId, active: true }, select: { id: true } }),
  ]);

  const admin = user?.isPlatformAdmin ?? false;
  const isParent = childLinks.length > 0;
  const showStudentView = !admin && !isParent && (studentAccount || !membership);
  const showParentView = !admin && !studentAccount;

  return {
    showParentView,
    showStudentView,
    children: childLinks.map((link) => ({
      linkId: link.id,
      firstName: link.studentUser.firstName,
      lastName: link.studentUser.lastName,
      since: link.createdAt,
      branches: [...new Set(link.studentUser.studentProfiles.map((profile) => profile.center.name))],
    })),
    parents: parentRows.map((link) => ({
      linkId: link.id,
      firstName: link.parentUser.firstName,
      lastName: link.parentUser.lastName,
      since: link.createdAt,
    })),
    invitations: invitations.map((row) => ({
      id: row.id,
      source: row.source,
      hint: row.codeHint,
      createdAt: row.createdAt,
      declaredParentName: [row.declaredParentFirstName, row.declaredParentLastName].filter(Boolean).join(" ") || null,
      branchName: row.issuingCenter?.name ?? null,
    })),
    slotsUsed: parentRows.length + invitations.length,
  };
}
