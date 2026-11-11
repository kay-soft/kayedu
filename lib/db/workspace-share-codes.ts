import type { Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose: `npm run check:workspaces` runs this module
// directly, outside the Next.js runtime (the lib/db/workspaces.ts reasoning).
// The client is injected.
import { requireEmailConfirmation } from "../auth/auth-config.ts";
import { checkRateLimits } from "../rate-limit.ts";
import { WORKSPACE_SHARE_CODE_DAYS, normalizeWorkspaceShareCode } from "../workspace-share-code.ts";
import { generateAssistantCode, hashAssistantCode } from "./assistants.ts";
import { writeAuditRow } from "./audit-row.ts";
import { workspaceTeacherNames } from "./notifications.ts";
import { WRITE_TRANSACTION_OPTIONS } from "./session-lifecycle.ts";
import { scopedWhere } from "./tenant-scope.ts";
import { moveWorkspaceProfileToAccount } from "./workspace-students.ts";
import {
  LIVE_WORKSPACE,
  authorizeWrite,
  resolveWorkspaceAccess,
  workspaceCan,
  type WorkspaceAuthError,
} from "./workspaces.ts";

/**
 * Workspace share codes (W10, D-W43; docs/02-architecture.md §18) — the
 * **only** writer of `WorkspaceShareCode`, and the one place every rule lives.
 *
 * 1. **The teacher side.** "Share code" on an unlinked profile needs what
 *    every workspace student write needs: `authorizeWrite` — the owner, the
 *    fixed `workspace.students.manage`, premium now, not archived — re-run
 *    inside the transaction. It revokes any active code for the profile and
 *    issues a new one (at most one active per profile, the hand-written
 *    partial unique index `WorkspaceShareCode_one_active_per_profile`, rule
 *    7). **Revoke reduces access**, so it needs ownership and the capability
 *    only — no premium, archived or not (the D-W37 precedent). An assistant is
 *    never the owner, so both are `notFound` for one (D-W43 item 2).
 * 2. **Codes are sha256 only**, 12 symbols of the parent/assistant alphabet
 *    (`lib/workspace-share-code.ts`, the assistant generator), shown once,
 *    never retrievable, single use (a conditional claim), expire after 7 days.
 * 3. **Redemption** is two calls: a preview that writes nothing (the
 *    workspace's name and its teacher's), then Confirm. Both are rate-limited
 *    per account and per client IP **before** anything is looked up. Unknown,
 *    expired, used and revoked codes give one answer (`invalidCode`); the
 *    account already holding a profile in the workspace (`alreadyInWorkspace`),
 *    the profile already linked (`alreadyLinked`) and the workspace's own
 *    owner (`ownWorkspace`) are refused. No premium is needed and an archived
 *    workspace still redeems, as accepting an invitation does (W8b).
 * 4. **Confirm is one transaction**: the code claimed conditionally (of two
 *    redemptions racing on one code exactly one wins), any PENDING invitation
 *    for the profile cancelled, and **the W8b move**
 *    (`moveWorkspaceProfileToAccount`, unchanged) — the profile to the
 *    redeemer's own `User`, the placeholder deleted only when it holds nothing
 *    else. Audited, ids only.
 * 5. **The teacher learns nothing about the account** (D-W27 intact): the code
 *    is a secret only the teacher holds; their reads say Linked / Not linked
 *    and whether a code of theirs is still active — never the redeemer's name,
 *    email or id. No phone is read anywhere here (CLAUDE.md rule 4).
 * 6. **Audit** (rule 7, D-20): `workspace.code.create|revoke|redeem` — ids and
 *    the expiry only, never the code.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

const STUDENTS = "workspace.students.manage" as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export const WORKSPACE_CODE_AUDIT = {
  create: "workspace.code.create",
  revoke: "workspace.code.revoke",
  redeem: "workspace.code.redeem",
} as const;

/** A code can be redeemed: unused, unrevoked, and `expiresAt` strictly after now. */
export function isShareCodeUsable(code: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): boolean {
  return code.usedAt === null && code.revokedAt === null && code.expiresAt.getTime() > now.getTime();
}

function activeWhere(now: Date): Prisma.WorkspaceShareCodeWhereInput {
  return { usedAt: null, revokedAt: null, expiresAt: { gt: now } };
}

/** Serializes code writes for one profile: a lock on its row. */
async function lockProfile(tx: Tx, centerId: string, studentProfileId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "StudentProfile" WHERE "id" = ${studentProfileId} AND "centerId" = ${centerId} FOR UPDATE`;
}

// ── The teacher's side ──────────────────────────────────────────────────────

export type CreateShareCodeResult =
  | { ok: true; code: string; codeId: string; expiresAt: Date; replaced: boolean }
  | { ok: false; error: WorkspaceAuthError | "rateLimited" | "alreadyLinked" };

/**
 * "Share code" (D-W43 item 2): a fresh code for one of the workspace's own
 * unlinked profiles — returned once, never stored. Any active code for the
 * profile is revoked first, in the same transaction (audited as a revoke).
 */
export async function createWorkspaceShareCode(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  studentProfileId: string,
  now: Date = new Date(),
): Promise<CreateShareCodeResult> {
  const gate = await authorizeWrite(db, actorUserId, workspaceId, STUDENTS, now);
  if (!gate.ok) return gate;
  if (!(await checkRateLimits([{ name: "workspaceShareCodePerUser", key: actorUserId }]))) {
    return { ok: false, error: "rateLimited" };
  }
  return db.$transaction(async (tx): Promise<CreateShareCodeResult> => {
    const again = await authorizeWrite(tx, actorUserId, workspaceId, STUDENTS, now);
    if (!again.ok) return again;
    const centerId = again.access.centerId;
    await lockProfile(tx, centerId, studentProfileId);
    const profile = await tx.studentProfile.findFirst({
      where: scopedWhere(centerId, { id: studentProfileId }),
      select: { id: true, user: { select: { authId: true } } },
    });
    if (!profile) return { ok: false, error: "notFound" };
    if (profile.user.authId) return { ok: false, error: "alreadyLinked" };

    // Every unused, unrevoked code — expired ones too, so the partial index
    // (which knows no clock) always has room for the new one.
    const previous = await tx.workspaceShareCode.findMany({
      where: scopedWhere(centerId, { studentProfileId: profile.id, usedAt: null, revokedAt: null }),
      select: { id: true, expiresAt: true },
    });
    for (const row of previous) {
      await tx.workspaceShareCode.updateMany({ where: scopedWhere(centerId, { id: row.id }), data: { revokedAt: now } });
      if (row.expiresAt.getTime() > now.getTime()) {
        await writeAuditRow(tx, {
          centerId,
          actorUserId,
          action: WORKSPACE_CODE_AUDIT.revoke,
          entityType: "WorkspaceShareCode",
          entityId: row.id,
          after: { studentProfileId: profile.id, revoked: true, replaced: true },
        });
      }
    }
    const replaced = previous.some((row) => row.expiresAt.getTime() > now.getTime());

    // 31^12 codes: a collision is ~never, but cheap to rule out before the insert.
    let code = generateAssistantCode();
    while (await tx.workspaceShareCode.findUnique({ where: { codeHash: hashAssistantCode(code) }, select: { id: true } })) {
      code = generateAssistantCode();
    }
    const expiresAt = new Date(now.getTime() + WORKSPACE_SHARE_CODE_DAYS * DAY_MS);
    const row = await tx.workspaceShareCode.create({
      data: {
        centerId,
        studentProfileId: profile.id,
        createdByUserId: actorUserId,
        codeHash: hashAssistantCode(code),
        expiresAt,
        createdAt: now,
      },
      select: { id: true },
    });
    await writeAuditRow(tx, {
      centerId,
      actorUserId,
      action: WORKSPACE_CODE_AUDIT.create,
      entityType: "WorkspaceShareCode",
      entityId: row.id,
      after: { studentProfileId: profile.id, expiresAt: expiresAt.toISOString() },
    });
    return { ok: true, code, codeId: row.id, expiresAt, replaced };
  }, WRITE_TRANSACTION_OPTIONS);
}

export type RevokeShareCodeResult = { ok: true } | { ok: false; error: "notFound" | "forbidden" };

/**
 * "Revoke code" (D-W43 item 2): the profile's active code stops working at
 * once. Reducing access — ownership and the capability only, premium lapsed
 * or the workspace archived alike. `notFound` when no code is active.
 */
export async function revokeWorkspaceShareCode(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  studentProfileId: string,
  now: Date = new Date(),
): Promise<RevokeShareCodeResult> {
  return db.$transaction(async (tx): Promise<RevokeShareCodeResult> => {
    const access = await resolveWorkspaceAccess(tx, actorUserId, workspaceId);
    if (!access) return { ok: false, error: "notFound" };
    if (!workspaceCan({ workspace: access }, STUDENTS)) return { ok: false, error: "forbidden" };
    await lockProfile(tx, access.centerId, studentProfileId);
    const active = await tx.workspaceShareCode.findMany({
      where: scopedWhere(access.centerId, { studentProfileId, ...activeWhere(now) }),
      select: { id: true },
    });
    if (active.length === 0) return { ok: false, error: "notFound" };
    for (const row of active) {
      const revoked = await tx.workspaceShareCode.updateMany({
        where: scopedWhere(access.centerId, { id: row.id, usedAt: null, revokedAt: null }),
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) continue;
      await writeAuditRow(tx, {
        centerId: access.centerId,
        actorUserId,
        action: WORKSPACE_CODE_AUDIT.revoke,
        entityType: "WorkspaceShareCode",
        entityId: row.id,
        after: { studentProfileId, revoked: true },
      });
    }
    return { ok: true };
  }, WRITE_TRANSACTION_OPTIONS);
}

/**
 * The teacher's read for the Students page: when each profile's active code
 * stops working. Only the expiry — never who redeemed what (a used code is
 * simply a Linked profile).
 */
export async function activeShareCodeExpiries(db: Db, centerId: string, now: Date = new Date()): Promise<Map<string, Date>> {
  const rows = await db.workspaceShareCode.findMany({
    where: scopedWhere(centerId, activeWhere(now)),
    select: { studentProfileId: true, expiresAt: true },
    take: 1000,
  });
  return new Map(rows.map((row) => [row.studentProfileId, row.expiresAt]));
}

// ── The redeemer's side (/workspace-join) ───────────────────────────────────

export type WorkspaceJoinError =
  | "rateLimited"
  | "forbidden"
  | "unverified"
  | "invalidCode"
  | "ownWorkspace"
  | "alreadyInWorkspace"
  | "alreadyLinked";

export type WorkspaceJoinRefusal = { ok: false; error: WorkspaceJoinError };

type RedeemContext = { userId: string; code: unknown; ip: string; now?: Date };

/** The account checks and the rate limit, before any code is looked up. */
async function redeemerGate(db: Db, input: RedeemContext): Promise<WorkspaceJoinError | null> {
  const allowed = await checkRateLimits([
    { name: "workspaceJoinPerUser", key: input.userId },
    { name: "workspaceJoinPerIp", key: input.ip },
  ]);
  if (!allowed) return "rateLimited";
  const user = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, authId: true, emailVerifiedAt: true } });
  if (!user || !user.authId) return "forbidden";
  // "Any verified account": under REQUIRE_EMAIL_CONFIRMATION the login's email is confirmed.
  if (requireEmailConfirmation() && user.emailVerifiedAt === null) return "unverified";
  return null;
}

const CODE_SELECT = {
  id: true,
  centerId: true,
  studentProfileId: true,
  usedAt: true,
  revokedAt: true,
  expiresAt: true,
  center: { select: { name: true, organization: { select: { ownerUserId: true } } } },
} satisfies Prisma.WorkspaceShareCodeSelect;

/** The code a typed value names, if it can be redeemed now in a live workspace — else one answer for every reason. */
async function usableCode(db: Db, code: unknown, now: Date) {
  const normalized = normalizeWorkspaceShareCode(code);
  if (!normalized) return null;
  const row = await db.workspaceShareCode.findFirst({
    where: { codeHash: hashAssistantCode(normalized), center: LIVE_WORKSPACE },
    select: CODE_SELECT,
  });
  return row && isShareCodeUsable(row, now) ? row : null;
}

/** The refusals that depend on the account and the profile (re-checked inside Confirm). */
async function accountRefusal(
  db: Db,
  row: { centerId: string; studentProfileId: string; center: { organization: { ownerUserId: string | null } } },
  userId: string,
): Promise<WorkspaceJoinError | null> {
  if (row.center.organization.ownerUserId === userId) return "ownWorkspace";
  const already = await db.studentProfile.count({ where: scopedWhere(row.centerId, { userId }) });
  if (already > 0) return "alreadyInWorkspace";
  const profile = await db.studentProfile.findFirst({
    where: scopedWhere(row.centerId, { id: row.studentProfileId }),
    select: { user: { select: { authId: true } } },
  });
  if (!profile) return "invalidCode";
  if (profile.user.authId) return "alreadyLinked";
  return null;
}

export type ShareCodePreview = { ok: true; workspaceName: string; teacherName: string | null };

/**
 * Step one: what the code would link — the workspace's name and its
 * teacher's (their local record there) — for the confirmation. Writes
 * nothing, but the attempt counts against the rate limit.
 */
export async function previewWorkspaceShareCode(
  db: PrismaClient,
  input: RedeemContext,
): Promise<ShareCodePreview | WorkspaceJoinRefusal> {
  const now = input.now ?? new Date();
  const refused = await redeemerGate(db, input);
  if (refused) return { ok: false, error: refused };
  const row = await usableCode(db, input.code, now);
  if (!row) return { ok: false, error: "invalidCode" };
  const blocked = await accountRefusal(db, row, input.userId);
  if (blocked) return { ok: false, error: blocked };
  const teachers = await workspaceTeacherNames(db, [row.centerId]);
  return { ok: true, workspaceName: row.center.name, teacherName: teachers.get(row.centerId) ?? null };
}

export type RedeemShareCodeResult =
  | { ok: true; studentProfileId: string; centerId: string; placeholderRemoved: boolean }
  | WorkspaceJoinRefusal;

/** Thrown inside Confirm to roll back when the profile moved under it. */
class ProfileMovedConcurrently extends Error {}

/**
 * Step two, after Confirm: one transaction — the code re-read and every
 * refusal re-checked, the code claimed **conditionally** (of two redemptions
 * racing on one code exactly one wins; the other is `invalidCode`), any
 * PENDING invitation for the profile cancelled, the W8b move, and
 * `workspace.code.redeem` audited, ids only. A profile moved by a concurrent
 * invitation acceptance rolls everything back (`alreadyLinked`); the same
 * account racing two codes into one workspace is stopped by
 * `StudentProfile @@unique([userId, centerId])` (`alreadyInWorkspace`).
 */
export async function redeemWorkspaceShareCode(db: PrismaClient, input: RedeemContext): Promise<RedeemShareCodeResult> {
  const now = input.now ?? new Date();
  const refused = await redeemerGate(db, input);
  if (refused) return { ok: false, error: refused };
  const found = await usableCode(db, input.code, now);
  if (!found) return { ok: false, error: "invalidCode" };

  try {
    return await db.$transaction(async (tx): Promise<RedeemShareCodeResult> => {
      const row = await tx.workspaceShareCode.findFirst({
        where: { id: found.id, center: LIVE_WORKSPACE },
        select: CODE_SELECT,
      });
      if (!row || !isShareCodeUsable(row, now)) return { ok: false, error: "invalidCode" };
      const blocked = await accountRefusal(tx, row, input.userId);
      if (blocked) return { ok: false, error: blocked };

      const claimed = await tx.workspaceShareCode.updateMany({
        where: { id: row.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now, usedByUserId: input.userId },
      });
      if (claimed.count !== 1) return { ok: false, error: "invalidCode" };

      const profile = await tx.studentProfile.findFirst({
        where: scopedWhere(row.centerId, { id: row.studentProfileId }),
        select: { id: true, userId: true, user: { select: { authId: true } } },
      });
      if (!profile || profile.user.authId) throw new ProfileMovedConcurrently();
      await tx.workspaceInvitation.updateMany({
        where: scopedWhere(row.centerId, { studentProfileId: profile.id, status: "PENDING" as const }),
        data: { status: "CANCELLED", respondedAt: now },
      });
      const move = await moveWorkspaceProfileToAccount(tx, {
        centerId: row.centerId,
        studentProfileId: profile.id,
        placeholderUserId: profile.userId,
        accountUserId: input.userId,
        now,
      });
      if (!move.moved) throw new ProfileMovedConcurrently();

      await writeAuditRow(tx, {
        centerId: row.centerId,
        actorUserId: input.userId,
        action: WORKSPACE_CODE_AUDIT.redeem,
        entityType: "WorkspaceShareCode",
        entityId: row.id,
        after: { studentProfileId: profile.id, placeholderRemoved: move.placeholderRemoved },
      });
      return { ok: true, studentProfileId: profile.id, centerId: row.centerId, placeholderRemoved: move.placeholderRemoved };
    }, WRITE_TRANSACTION_OPTIONS);
  } catch (error) {
    if (error instanceof ProfileMovedConcurrently) return { ok: false, error: "alreadyLinked" };
    if (error instanceof Object && "code" in error && (error as { code?: string }).code === "P2002") {
      return { ok: false, error: "alreadyInWorkspace" };
    }
    throw error;
  }
}
