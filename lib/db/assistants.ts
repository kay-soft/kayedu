import { createHash, randomInt } from "node:crypto";
import type { AssistantPreset, Prisma, PrismaClient } from "@prisma/client";
// Relative imports on purpose — `npm run check:assistants` exercises this
// module directly, outside the Next.js runtime (same as lib/db/parents.ts).
import {
  ASSISTANT_CODE_ALPHABET,
  ASSISTANT_CODE_LENGTH,
  ASSISTANT_LIMITS,
  PRESET_PERMISSIONS,
  detectPreset,
  isAssistantPermission,
  isAssistantPreset,
  normalizeAssistantCode,
  sortPermissions,
  type AssistantPermission,
  type AssistantPresetName,
  type AssistantPresetView,
} from "../assistant-catalog.ts";
import { requireEmailConfirmation } from "../auth/auth-config.ts";
import { isPremium, requirePremium } from "../auth/premium.ts";
import { fullName } from "../identity.ts";
import { checkRateLimits } from "../rate-limit.ts";
import { writeAuditRow } from "./audit-row.ts";
import { ACCESSIBLE_CENTER } from "./platform.ts";
import { WRITE_TRANSACTION_OPTIONS } from "./session-lifecycle.ts";
import { ownedWorkspaceWhere } from "./workspaces.ts";

/**
 * Teacher assistants (W7a — D-W16, D-W17, D-W36; docs/01-data-model.md
 * "Assistants"). The **only** writer of `AssistantInvite`, `TeacherAssistant`
 * and `AssistantPermissionGrant`, and the one place every rule lives:
 *
 * 1. **The teacher side.** Every teacher write loads the actor fresh inside
 *    its transaction: an active TEACHER membership at an accessible branch,
 *    or (W8d) in a workspace the account owns (`forbidden` otherwise). **Widening access needs premium** — creating an
 *    invite and changing permissions add `requirePremium` (`premiumRequired`).
 *    **Reducing access never does** (W7b, D-W37 item 12): revoking an invite
 *    and removing an assistant work for a lapsed teacher too, like the
 *    assistant's own Leave. A row is always looked up by its id **and** the
 *    actor as its teacher, so another teacher's id is `notFound`, never a write.
 * 2. **Five slots** — active links + pending invites (unused, unrevoked,
 *    `expiresAt > now`) — counted under a row lock on the teacher's `User`
 *    (`SELECT … FOR UPDATE`), so two concurrent creations cannot both take the
 *    fifth slot.
 * 3. **Codes are sha256 only**, 12 symbols, shown once, single use (a
 *    conditional claim), expire after 7 days. Unknown, expired, used and
 *    revoked codes give one answer (`invalidCode`). Redemption is
 *    rate-limited per account and per client IP **before** anything is looked
 *    up, and both the preview and the confirm count.
 * 4. **Nothing links without Confirm.** `previewAssistantCode` reads only; only
 *    `redeemAssistantCode` writes: the invite is claimed, the link and its
 *    preset's grants created and `assistant.invite.redeem` audited in one
 *    transaction.
 * 5. **Effective = live link + premium teacher, worked out on read** (D-W15,
 *    rule 12). A lapsed teacher's links and grants stay; renewal restores
 *    them. A removed or left link (`revokedAt`) is never effective.
 * 6. **No centre anything.** An assistant gets no Membership, no permission
 *    grant and no tenant context here; nothing in this module reads a tenant
 *    table except the teacher's own membership check.
 * 7. **Audit** (rule 7, D-20): `assistant.invite.create|revoke|redeem`,
 *    `assistant.link.remove|leave`, `assistant.permission.update` — ids,
 *    the preset and permission names only, never a code, a name or an email.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

export const ASSISTANT_AUDIT_ACTIONS = {
  inviteCreate: "assistant.invite.create",
  inviteRevoke: "assistant.invite.revoke",
  inviteRedeem: "assistant.invite.redeem",
  linkRemove: "assistant.link.remove",
  linkLeave: "assistant.link.leave",
  permissionUpdate: "assistant.permission.update",
} as const;

export type AssistantError =
  | "forbidden"
  | "premiumRequired"
  | "slotsFull"
  | "notFound"
  | "unknownPreset"
  | "unknownPermission"
  | "rateLimited"
  | "invalidCode"
  | "ownCode"
  | "teacherUnavailable"
  | "alreadyAssistant"
  | "unverified";

export type AssistantRefusal = { ok: false; error: AssistantError };

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Codes ────────────────────────────────────────────────────────────────

/** A fresh code, 12 symbols, uniformly drawn with the CSPRNG. */
export function generateAssistantCode(): string {
  let code = "";
  for (let index = 0; index < ASSISTANT_CODE_LENGTH; index += 1) {
    code += ASSISTANT_CODE_ALPHABET[randomInt(ASSISTANT_CODE_ALPHABET.length)];
  }
  return code;
}

/** The only form of a code the database ever holds. */
export function hashAssistantCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

// ── Shared ───────────────────────────────────────────────────────────────

/** Serializes every slot-counting write for one teacher: a lock on their `User` row. */
async function lockTeacher(tx: Tx, teacherUserId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${teacherUserId} FOR UPDATE`;
}

function pendingWhere(teacherUserId: string, now: Date): Prisma.AssistantInviteWhereInput {
  return { teacherUserId, usedAt: null, revokedAt: null, expiresAt: { gt: now } };
}

/** Active links + pending invites — the 5-slot count. */
export async function assistantSlotsInUse(db: Db, teacherUserId: string, now: Date = new Date()): Promise<number> {
  const [links, invites] = await Promise.all([
    db.teacherAssistant.count({ where: { teacherUserId, revokedAt: null } }),
    db.assistantInvite.count({ where: pendingWhere(teacherUserId, now) }),
  ]);
  return links + invites;
}

/** An invite can be redeemed: unused, unrevoked, and `expiresAt` strictly after now. */
export function isInviteUsable(invite: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): boolean {
  return invite.usedAt === null && invite.revokedAt === null && invite.expiresAt.getTime() > now.getTime();
}

/**
 * A teacher account: an active TEACHER membership at an accessible branch (the
 * `hasTeacherMembership` rule) **or — since W8d (D-W41 item 11) — in a
 * PERSONAL workspace the account owns** (`ownedWorkspaceWhere`), so a
 * workspace-only premium teacher may invite: the resolver no longer needs a
 * branch for the link to mean something.
 */
export async function isTeacherAccount(db: Db, userId: string): Promise<boolean> {
  const count = await db.membership.count({
    where: { userId, role: "TEACHER", active: true, OR: [{ center: ACCESSIBLE_CENTER }, { center: ownedWorkspaceWhere(userId) }] },
  });
  return count > 0;
}

/**
 * The teacher side's authority for a write that **widens** access (an invite,
 * a permission change): a teacher, and premium now. Run inside the write's own
 * transaction, after the lock, so the check and the write see the same row.
 */
async function teacherGate(tx: Tx, actorUserId: string | null | undefined, now: Date): Promise<AssistantError | null> {
  const refused = await teacherActorGate(tx, actorUserId);
  if (refused) return refused;
  const premium = await requirePremium(tx, actorUserId!, now);
  return premium.ok ? null : "premiumRequired";
}

/**
 * The authority for a write that only **reduces** access — revoking an invite,
 * removing an assistant (W7b, D-W37 item 12): a teacher, premium or not. The
 * row is still found with the actor as its teacher.
 */
async function teacherActorGate(tx: Tx, actorUserId: string | null | undefined): Promise<AssistantError | null> {
  if (!actorUserId) return "forbidden";
  return (await isTeacherAccount(tx, actorUserId)) ? null : "forbidden";
}

function inTransaction<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(fn, WRITE_TRANSACTION_OPTIONS);
}

async function writeGrants(tx: Tx, linkId: string, permissions: readonly AssistantPermission[]): Promise<void> {
  await tx.assistantPermissionGrant.deleteMany({ where: { assistantId: linkId } });
  if (permissions.length > 0) {
    await tx.assistantPermissionGrant.createMany({
      data: permissions.map((permission) => ({ assistantId: linkId, permission })),
    });
  }
}

/** A link's grants as catalogue names, in catalogue order (anything else is ignored, never granted). */
function grantNames(grants: { permission: string }[]): AssistantPermission[] {
  return sortPermissions(grants.map((grant) => grant.permission).filter(isAssistantPermission));
}

// ── The teacher's side (/teacher/assistants) ─────────────────────────────

export type CreatedInvite = { ok: true; code: string; inviteId: string; expiresAt: Date; preset: AssistantPresetName };

/**
 * "Invite an assistant": a pending invite with the chosen preset, and its
 * code — returned once, never stored. Refused for a non-teacher, a teacher
 * who is not premium now, an unknown preset, and once 5 slots are in use.
 */
export async function createAssistantInvite(
  db: PrismaClient,
  input: { actorUserId: string | null | undefined; preset: unknown; now?: Date },
): Promise<CreatedInvite | AssistantRefusal> {
  const now = input.now ?? new Date();
  if (!isAssistantPreset(input.preset)) return { ok: false, error: "unknownPreset" };
  const preset = input.preset;
  const actorUserId = input.actorUserId;
  if (!actorUserId) return { ok: false, error: "forbidden" };

  return inTransaction(db, async (tx): Promise<CreatedInvite | AssistantRefusal> => {
    await lockTeacher(tx, actorUserId);
    const refused = await teacherGate(tx, actorUserId, now);
    if (refused) return { ok: false, error: refused };
    if ((await assistantSlotsInUse(tx, actorUserId, now)) >= ASSISTANT_LIMITS.slotsPerTeacher) {
      return { ok: false, error: "slotsFull" };
    }

    // 31^12 codes: a collision is ~never, but cheap to rule out before the insert.
    let code = generateAssistantCode();
    while (await tx.assistantInvite.findUnique({ where: { codeHash: hashAssistantCode(code) }, select: { id: true } })) {
      code = generateAssistantCode();
    }
    const expiresAt = new Date(now.getTime() + ASSISTANT_LIMITS.inviteDays * DAY_MS);
    const invite = await tx.assistantInvite.create({
      data: { teacherUserId: actorUserId, codeHash: hashAssistantCode(code), preset, expiresAt, createdAt: now },
      select: { id: true },
    });
    await writeAuditRow(tx, {
      centerId: null,
      actorUserId,
      action: ASSISTANT_AUDIT_ACTIONS.inviteCreate,
      entityType: "AssistantInvite",
      entityId: invite.id,
      after: { preset, expiresAt: expiresAt.toISOString() },
    });
    return { ok: true, code, inviteId: invite.id, expiresAt, preset };
  });
}

/** The teacher cancels one of their own unused invites; its code stops working at once. No premium needed (D-W37). */
export async function revokeAssistantInvite(
  db: PrismaClient,
  input: { actorUserId: string | null | undefined; inviteId: string; now?: Date },
): Promise<{ ok: true } | AssistantRefusal> {
  const now = input.now ?? new Date();
  const actorUserId = input.actorUserId;
  if (!actorUserId) return { ok: false, error: "forbidden" };
  return inTransaction(db, async (tx): Promise<{ ok: true } | AssistantRefusal> => {
    await lockTeacher(tx, actorUserId);
    const refused = await teacherActorGate(tx, actorUserId);
    if (refused) return { ok: false, error: refused };
    const revoked = await tx.assistantInvite.updateMany({
      where: { id: input.inviteId, teacherUserId: actorUserId, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    if (revoked.count !== 1) return { ok: false, error: "notFound" };
    await writeAuditRow(tx, {
      centerId: null,
      actorUserId,
      action: ASSISTANT_AUDIT_ACTIONS.inviteRevoke,
      entityType: "AssistantInvite",
      entityId: input.inviteId,
      after: { revoked: true },
    });
    return { ok: true };
  });
}

export type PermissionChange =
  /** Choosing a preset writes exactly its grants. */
  | { preset: unknown }
  /** Toggles: the whole set of grants the link should hold afterwards. */
  | { permissions: unknown };

/**
 * Change one of the teacher's own assistant's permissions: a preset, or the
 * toggles. Every name must be in the catalogue (`unknownPermission`, nothing
 * written). The stored preset follows the grants when they are exactly a
 * preset, and keeps the last chosen one otherwise (the page then reads
 * "Custom", `detectPreset`). An unchanged set writes nothing.
 */
export async function updateAssistantPermissions(
  db: PrismaClient,
  input: { actorUserId: string | null | undefined; linkId: string; change: PermissionChange; now?: Date },
): Promise<{ ok: true; permissions: AssistantPermission[]; preset: AssistantPresetView; changed: boolean } | AssistantRefusal> {
  const now = input.now ?? new Date();
  const actorUserId = input.actorUserId;
  if (!actorUserId) return { ok: false, error: "forbidden" };

  let wanted: AssistantPermission[];
  if ("preset" in input.change) {
    if (!isAssistantPreset(input.change.preset)) return { ok: false, error: "unknownPreset" };
    wanted = [...PRESET_PERMISSIONS[input.change.preset]];
  } else {
    const raw = input.change.permissions;
    if (!Array.isArray(raw) || raw.length > 64 || !raw.every(isAssistantPermission)) {
      return { ok: false, error: "unknownPermission" };
    }
    wanted = sortPermissions(raw);
  }

  return inTransaction(db, async (tx) => {
    await lockTeacher(tx, actorUserId);
    const refused = await teacherGate(tx, actorUserId, now);
    if (refused) return { ok: false, error: refused } as const;
    const link = await tx.teacherAssistant.findFirst({
      where: { id: input.linkId, teacherUserId: actorUserId, revokedAt: null },
      include: { grants: true },
    });
    if (!link) return { ok: false, error: "notFound" } as const;

    const before = grantNames(link.grants);
    const detected = detectPreset(wanted);
    if (before.join() === wanted.join()) {
      return { ok: true, permissions: before, preset: detected, changed: false } as const;
    }
    const storedPreset: AssistantPreset = detected === "CUSTOM" ? link.preset : detected;
    await writeGrants(tx, link.id, wanted);
    if (storedPreset !== link.preset) {
      await tx.teacherAssistant.update({ where: { id: link.id }, data: { preset: storedPreset } });
    }
    await writeAuditRow(tx, {
      centerId: null,
      actorUserId,
      action: ASSISTANT_AUDIT_ACTIONS.permissionUpdate,
      entityType: "TeacherAssistant",
      entityId: link.id,
      before: { preset: link.preset, permissions: before },
      after: { preset: detected, permissions: wanted },
    });
    return { ok: true, permissions: wanted, preset: detected, changed: true } as const;
  });
}

/** The teacher removes one of their assistants (`revokedAt`, after a confirmation). Final; a new invite relinks. No premium needed (D-W37). */
export async function removeAssistant(
  db: PrismaClient,
  input: { actorUserId: string | null | undefined; linkId: string; now?: Date },
): Promise<{ ok: true } | AssistantRefusal> {
  const now = input.now ?? new Date();
  const actorUserId = input.actorUserId;
  if (!actorUserId) return { ok: false, error: "forbidden" };
  return inTransaction(db, async (tx): Promise<{ ok: true } | AssistantRefusal> => {
    await lockTeacher(tx, actorUserId);
    const refused = await teacherActorGate(tx, actorUserId);
    if (refused) return { ok: false, error: refused };
    const removed = await tx.teacherAssistant.updateMany({
      where: { id: input.linkId, teacherUserId: actorUserId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (removed.count !== 1) return { ok: false, error: "notFound" };
    await writeAuditRow(tx, {
      centerId: null,
      actorUserId,
      action: ASSISTANT_AUDIT_ACTIONS.linkRemove,
      entityType: "TeacherAssistant",
      entityId: input.linkId,
      after: { revoked: true, by: "teacher" },
    });
    return { ok: true };
  });
}

// ── The assistant's side (redeem, Account → Leave) ───────────────────────

export type InvitePreview = {
  ok: true;
  teacherUserId: string;
  teacherName: string;
  preset: AssistantPresetName;
  permissions: AssistantPermission[];
};

type RedeemContext = { userId: string; code: unknown; ip: string; now?: Date };

/** The account checks and the rate limit, before any code is looked up. */
async function redeemerGate(db: Db, input: RedeemContext): Promise<AssistantError | null> {
  const allowed = await checkRateLimits([
    { name: "assistantJoinPerUser", key: input.userId },
    { name: "assistantJoinPerIp", key: input.ip },
  ]);
  if (!allowed) return "rateLimited";
  const user = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, emailVerifiedAt: true } });
  if (!user) return "forbidden";
  // "Any verified account": under REQUIRE_EMAIL_CONFIRMATION the login's email is confirmed.
  if (requireEmailConfirmation() && user.emailVerifiedAt === null) return "unverified";
  return null;
}

/** The invite a typed code names, if it can be redeemed now — else one answer for every reason. */
async function usableInvite(db: Db, code: unknown, now: Date) {
  const normalized = normalizeAssistantCode(code);
  if (!normalized) return null;
  const invite = await db.assistantInvite.findUnique({
    where: { codeHash: hashAssistantCode(normalized) },
    include: { teacher: { select: { id: true, firstName: true, lastName: true } } },
  });
  return invite && isInviteUsable(invite, now) ? invite : null;
}

/**
 * Step one of redemption: what the code would link — the teacher's name and
 * the preset's permissions — for the confirmation. Writes nothing (but the
 * attempt counts against the rate limit).
 */
export async function previewAssistantCode(db: PrismaClient, input: RedeemContext): Promise<InvitePreview | AssistantRefusal> {
  const now = input.now ?? new Date();
  const refused = await redeemerGate(db, input);
  if (refused) return { ok: false, error: refused };
  const invite = await usableInvite(db, input.code, now);
  if (!invite) return { ok: false, error: "invalidCode" };
  if (invite.teacherUserId === input.userId) return { ok: false, error: "ownCode" };
  if (!(await requirePremium(db, invite.teacherUserId, now)).ok) return { ok: false, error: "teacherUnavailable" };
  const existing = await db.teacherAssistant.findFirst({
    where: { teacherUserId: invite.teacherUserId, assistantUserId: input.userId, revokedAt: null },
    select: { id: true },
  });
  if (existing) return { ok: false, error: "alreadyAssistant" };
  return {
    ok: true,
    teacherUserId: invite.teacherUserId,
    teacherName: fullName(invite.teacher),
    preset: invite.preset,
    permissions: [...PRESET_PERMISSIONS[invite.preset]],
  };
}

export type RedeemResult = { ok: true; linkId: string; teacherUserId: string } | AssistantRefusal;

/**
 * Step two, after Confirm: one transaction under the teacher's lock — the
 * invite re-read, every refusal re-checked (own code, teacher premium now, an
 * existing live link, the cap as an assertion), the invite claimed
 * **conditionally** (of two redemptions racing on one code exactly one wins;
 * the other is `invalidCode`), the link created with the preset's grants, and
 * `assistant.invite.redeem` audited, ids only.
 */
export async function redeemAssistantCode(db: PrismaClient, input: RedeemContext): Promise<RedeemResult> {
  const now = input.now ?? new Date();
  const refused = await redeemerGate(db, input);
  if (refused) return { ok: false, error: refused };
  const found = await usableInvite(db, input.code, now);
  if (!found) return { ok: false, error: "invalidCode" };

  return inTransaction(db, async (tx): Promise<RedeemResult> => {
    await lockTeacher(tx, found.teacherUserId);
    const invite = await tx.assistantInvite.findUnique({ where: { id: found.id } });
    if (!invite || !isInviteUsable(invite, now)) return { ok: false, error: "invalidCode" };
    if (invite.teacherUserId === input.userId) return { ok: false, error: "ownCode" };
    if (!(await requirePremium(tx, invite.teacherUserId, now)).ok) return { ok: false, error: "teacherUnavailable" };
    const existing = await tx.teacherAssistant.findFirst({
      where: { teacherUserId: invite.teacherUserId, assistantUserId: input.userId, revokedAt: null },
      select: { id: true },
    });
    if (existing) return { ok: false, error: "alreadyAssistant" };
    // The invite already holds a slot, so this cannot fail through invites; asserted anyway.
    const activeLinks = await tx.teacherAssistant.count({ where: { teacherUserId: invite.teacherUserId, revokedAt: null } });
    if (activeLinks >= ASSISTANT_LIMITS.slotsPerTeacher) return { ok: false, error: "slotsFull" };

    const claimed = await tx.assistantInvite.updateMany({
      where: { id: invite.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now, usedByUserId: input.userId },
    });
    if (claimed.count !== 1) return { ok: false, error: "invalidCode" };

    const permissions = [...PRESET_PERMISSIONS[invite.preset]];
    const link = await tx.teacherAssistant.create({
      data: { teacherUserId: invite.teacherUserId, assistantUserId: input.userId, preset: invite.preset, createdAt: now },
      select: { id: true },
    });
    await writeGrants(tx, link.id, permissions);
    await writeAuditRow(tx, {
      centerId: null,
      actorUserId: input.userId,
      action: ASSISTANT_AUDIT_ACTIONS.inviteRedeem,
      entityType: "TeacherAssistant",
      entityId: link.id,
      after: { inviteId: invite.id, teacherUserId: invite.teacherUserId, preset: invite.preset, permissions },
    });
    return { ok: true, linkId: link.id, teacherUserId: invite.teacherUserId };
  });
}

/** The assistant ends their own link (Account settings → Leave). No premium needed. */
export async function leaveAssistantLink(
  db: PrismaClient,
  input: { actorUserId: string | null | undefined; linkId: string; now?: Date },
): Promise<{ ok: true } | AssistantRefusal> {
  const now = input.now ?? new Date();
  const actorUserId = input.actorUserId;
  if (!actorUserId) return { ok: false, error: "forbidden" };
  return inTransaction(db, async (tx): Promise<{ ok: true } | AssistantRefusal> => {
    const left = await tx.teacherAssistant.updateMany({
      where: { id: input.linkId, assistantUserId: actorUserId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (left.count !== 1) return { ok: false, error: "notFound" };
    await writeAuditRow(tx, {
      centerId: null,
      actorUserId,
      action: ASSISTANT_AUDIT_ACTIONS.linkLeave,
      entityType: "TeacherAssistant",
      entityId: input.linkId,
      after: { revoked: true, by: "assistant" },
    });
    return { ok: true };
  });
}

// ── Reads ────────────────────────────────────────────────────────────────

export type EffectiveAssistantLink = {
  linkId: string;
  teacherUserId: string;
  teacherName: string;
  permissions: AssistantPermission[];
  preset: AssistantPresetView;
  since: Date;
};

const LINK_INCLUDE = {
  teacher: { select: { id: true, firstName: true, lastName: true, premiumUntil: true } },
  grants: { select: { permission: true } },
} as const;

type LinkRow = Prisma.TeacherAssistantGetPayload<{ include: typeof LINK_INCLUDE }>;

function toEffective(row: LinkRow): EffectiveAssistantLink {
  const permissions = grantNames(row.grants);
  return {
    linkId: row.id,
    teacherUserId: row.teacherUserId,
    teacherName: fullName(row.teacher),
    permissions,
    preset: detectPreset(permissions),
    since: row.createdAt,
  };
}

/**
 * The account's **effective** links: live (`revokedAt` null) and the teacher
 * premium now (`isPremium`, per request). The only read the experience list,
 * the assistant shell and Account settings build on — so a lapsed teacher's
 * name and the link disappear together, and renewal brings both back.
 */
export async function effectiveAssistantLinks(
  db: Db,
  assistantUserId: string,
  now: Date = new Date(),
): Promise<EffectiveAssistantLink[]> {
  const rows = await db.teacherAssistant.findMany({
    where: { assistantUserId, revokedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: LINK_INCLUDE,
  });
  return rows.filter((row) => isPremium(row.teacher, now)).map(toEffective);
}

/**
 * The one effective link of the session user for the route's teacher, or
 * null. Both ids come from the server: the session's user and the route
 * segment — never a posted link id — so swapping the teacherId in the URL can
 * only ever find the caller's own link with that teacher.
 */
export async function findEffectiveAssistantLink(
  db: Db,
  input: { assistantUserId: string; teacherUserId: string; now?: Date },
): Promise<EffectiveAssistantLink | null> {
  const row = await db.teacherAssistant.findFirst({
    where: { assistantUserId: input.assistantUserId, teacherUserId: input.teacherUserId, revokedAt: null },
    include: LINK_INCLUDE,
  });
  if (!row || !isPremium(row.teacher, input.now ?? new Date())) return null;
  return toEffective(row);
}

export type TeacherAssistantsOverview = {
  assistants: {
    linkId: string;
    assistantName: string;
    permissions: AssistantPermission[];
    preset: AssistantPresetView;
    since: Date;
  }[];
  pendingInvites: { inviteId: string; preset: AssistantPresetName; expiresAt: Date; createdAt: Date }[];
  slotsUsed: number;
};

/** The teacher's own page: live links (whatever premium says — they own them) and pending invites. */
export async function teacherAssistantsOverview(
  db: Db,
  teacherUserId: string,
  now: Date = new Date(),
): Promise<TeacherAssistantsOverview> {
  const [links, invites] = await Promise.all([
    db.teacherAssistant.findMany({
      where: { teacherUserId, revokedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { assistant: { select: { firstName: true, lastName: true } }, grants: { select: { permission: true } } },
    }),
    db.assistantInvite.findMany({
      where: pendingWhere(teacherUserId, now),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, preset: true, expiresAt: true, createdAt: true },
    }),
  ]);
  return {
    assistants: links.map((link) => {
      const permissions = grantNames(link.grants);
      return {
        linkId: link.id,
        assistantName: fullName(link.assistant),
        permissions,
        preset: detectPreset(permissions),
        since: link.createdAt,
      };
    }),
    pendingInvites: invites.map((invite) => ({
      inviteId: invite.id,
      preset: invite.preset,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    })),
    slotsUsed: links.length + invites.length,
  };
}
