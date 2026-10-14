import type { Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:security` exercises this module
// directly, outside the Next.js runtime.
import { fullName, localName } from "../identity.ts";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Account claims (SEC-2a, D-01; docs/01-data-model.md "People layer").
 *
 * A sign-up whose email equals a person a centre created (`User.authId` null)
 * is never linked to that person by `syncUserFromAuth`
 * (`lib/auth/identity-link.ts`) — it opens a PENDING `AccountClaim` and the
 * login has no app user until a staff member, with the person in front of
 * them, approves it here. `AccountClaim` is global like `User`; what keeps the
 * staff side tenant-safe is that every read and every decision below requires
 * the claimed person to hold a relation **at the acting centre**
 * (`targetKnownHere`) — a claim on a person this centre does not know is
 * invisible to it and refused by direct call.
 */

/** The claimed person holds a student profile or a membership at `centerId`. */
function targetKnownHere(centerId: string): Prisma.UserWhereInput {
  return {
    OR: [
      { studentProfiles: { some: { centerId } } },
      { memberships: { some: { centerId } } },
    ],
  };
}

export type PendingAccountClaim = {
  id: string;
  /** The email the claimant signed up with (it equals the person's email). */
  email: string;
  createdAt: Date;
  /** This centre's own name for the person. */
  name: string;
  /** How this centre knows them. */
  relation: "student" | "teacher" | "staff";
};

export async function pendingClaimsForCenter(
  db: Db,
  centerId: string,
): Promise<PendingAccountClaim[]> {
  const claims = await db.accountClaim.findMany({
    where: { status: "PENDING", targetUser: targetKnownHere(centerId) },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: {
      id: true,
      email: true,
      createdAt: true,
      targetUser: {
        select: {
          firstName: true,
          lastName: true,
          studentProfiles: {
            where: { centerId },
            select: { firstName: true, lastName: true },
            take: 1,
          },
          memberships: {
            where: { centerId },
            select: { firstName: true, lastName: true, role: true },
            take: 1,
          },
        },
      },
    },
  });

  return claims.map((claim) => {
    const user = claim.targetUser;
    const profile = user.studentProfiles[0];
    const membership = user.memberships[0];
    const local = profile ?? membership ?? { firstName: null, lastName: null };
    return {
      id: claim.id,
      email: claim.email,
      createdAt: claim.createdAt,
      name: fullName(localName(local, user)),
      relation: profile ? "student" : membership?.role === "TEACHER" ? "teacher" : "staff",
    };
  });
}

export type ResolveClaimResult =
  | { ok: true; claimId: string; targetUserId: string }
  | { ok: false; error: "notFound" | "alreadyResolved" | "alreadyLinked" };

/**
 * Approve: the claimant's login becomes this person's login. In one
 * transaction, conditionally — the target must still have no login and the
 * claim must still be PENDING — so two staff members (or two claims) racing
 * can never both win. Every other open claim on the person is closed, and the
 * decision is audited at the acting centre.
 */
export async function approveAccountClaim(
  db: PrismaClient,
  params: { claimId: string; centerId: string; actorUserId: string },
): Promise<ResolveClaimResult> {
  return db.$transaction(async (tx) => {
    const claim = await tx.accountClaim.findFirst({
      where: { id: params.claimId, targetUser: targetKnownHere(params.centerId) },
    });
    if (!claim) return { ok: false, error: "notFound" } as const;
    if (claim.status !== "PENDING") return { ok: false, error: "alreadyResolved" } as const;

    const loginTaken = await tx.user.findUnique({
      where: { authId: claim.authId },
      select: { id: true },
    });
    if (loginTaken) return { ok: false, error: "alreadyLinked" } as const;

    const linked = await tx.user.updateMany({
      where: { id: claim.targetUserId, authId: null, email: claim.email },
      data: { authId: claim.authId },
    });
    if (linked.count !== 1) return { ok: false, error: "alreadyLinked" } as const;

    const now = new Date();
    const resolved = await tx.accountClaim.updateMany({
      where: { id: claim.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        resolvedAt: now,
        resolvedBy: params.actorUserId,
        resolvedAtCenterId: params.centerId,
      },
    });
    if (resolved.count !== 1) throw new Error("account claim resolved concurrently");
    await tx.accountClaim.updateMany({
      where: { targetUserId: claim.targetUserId, status: "PENDING" },
      data: { status: "REJECTED", resolvedAt: now, resolvedBy: params.actorUserId, resolvedAtCenterId: params.centerId },
    });

    await tx.auditLog.create({
      data: {
        centerId: params.centerId,
        actorUserId: params.actorUserId,
        action: "account.claim.approve",
        entityType: "AccountClaim",
        entityId: claim.id,
        before: { status: "PENDING" },
        after: { status: "APPROVED", targetUserId: claim.targetUserId },
      },
    });
    return { ok: true, claimId: claim.id, targetUserId: claim.targetUserId } as const;
  });
}

/**
 * Reject: "this login is not that person". The person's global email — typed
 * by a centre, evidently someone else's (often a parent's) — is detached from
 * the unlinked record (every centre keeps its own local copy of the contact),
 * so the claimant's next request simply makes them a new person of their own.
 */
export async function rejectAccountClaim(
  db: PrismaClient,
  params: { claimId: string; centerId: string; actorUserId: string },
): Promise<ResolveClaimResult> {
  return db.$transaction(async (tx) => {
    const claim = await tx.accountClaim.findFirst({
      where: { id: params.claimId, targetUser: targetKnownHere(params.centerId) },
    });
    if (!claim) return { ok: false, error: "notFound" } as const;

    const resolved = await tx.accountClaim.updateMany({
      where: { id: claim.id, status: "PENDING" },
      data: {
        status: "REJECTED",
        resolvedAt: new Date(),
        resolvedBy: params.actorUserId,
        resolvedAtCenterId: params.centerId,
      },
    });
    if (resolved.count !== 1) return { ok: false, error: "alreadyResolved" } as const;

    await tx.user.updateMany({
      where: { id: claim.targetUserId, authId: null, email: claim.email },
      data: { email: null, emailVerifiedAt: null },
    });

    await tx.auditLog.create({
      data: {
        centerId: params.centerId,
        actorUserId: params.actorUserId,
        action: "account.claim.reject",
        entityType: "AccountClaim",
        entityId: claim.id,
        before: { status: "PENDING" },
        after: { status: "REJECTED", targetUserId: claim.targetUserId },
      },
    });
    return { ok: true, claimId: claim.id, targetUserId: claim.targetUserId } as const;
  });
}
