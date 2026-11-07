import type { CenterKind, Prisma, PrismaClient, Role, ShareType } from "@prisma/client";

// Relative imports on purpose: `npm run check:workspaces` runs this module
// directly, outside the Next.js runtime (the same reasoning as
// lib/db/assistants.ts and lib/db/platform.ts). The client is injected.
import { requirePremium } from "../auth/premium.ts";
import { MAX_PRICE_PIASTRES } from "../money.ts";
import { writeAuditRow } from "./audit-row.ts";
import { isWorkspacePairOffered } from "./catalog.ts";
import { PERSONAL_ONLY } from "./center-kind.ts";
import {
  createClassWithSessions,
  createManualSession,
  createOneOffSession,
  deactivateClass,
  deactivateClassInTransaction,
  deleteClass,
  deleteManualSession,
  reactivateClass,
  updateClassWithSessions,
  writeClassSlot,
  type ClassSlot,
} from "./class-sessions.ts";
import { ACCESSIBLE_LIFECYCLE_STATES, createPersonalWorkspace } from "./platform.ts";
import { WRITE_TRANSACTION_OPTIONS } from "./session-lifecycle.ts";
import { cancelSession, rescheduleSession } from "./sessions.ts";

/**
 * PERSONAL workspaces (W8a, D-W20, D-W21, D-W28, D-W38; docs/02-architecture.md
 * §18). A workspace is a `Center` with `kind = PERSONAL` under the teacher's
 * personal `Organization` (`ownerUserId`). It is a tenant like any branch —
 * every read and write below is scoped by its `centerId` — but its authority
 * is **owning it**, never the centre matrix (W-C3):
 *
 * - `resolveWorkspaceAccess` finds a workspace only for its owner: any other
 *   account — another teacher, a centre's staff, a student, an assistant, a
 *   platform admin acting as a normal user — gets `null`, so a swapped id is
 *   not-found, never forbidden;
 * - `workspaceCan` is the one place a workspace action is decided, against
 *   the fixed `WORKSPACE_OWNER_CAPABILITIES`;
 * - `assertWorkspaceWritable` adds what every write needs and no read does:
 *   the owner premium now (`requirePremium`, D-W15) and the workspace not
 *   archived (D-W28). Archiving is the one write premium does not gate —
 *   reducing what is active never is.
 *
 * Every writer here re-runs all three from the ids it is given, so a direct
 * call can never skip them. Classes and sessions go through the unchanged
 * class engine (`./class-sessions.ts`, `./sessions.ts`) with the workspace's
 * forced values: the owner as teacher, the hidden default room, the cut
 * PERCENTAGE 0 (D-W24, CLAUDE.md rule 15 — any other cut is refused), no
 * single-session booking and no self-serve joining (D-W22: never browsable).
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

const TEACHER: Role = "TEACHER";

/** D-W21: at most this many ACTIVE (not archived) workspaces per teacher. */
export const WORKSPACE_ACTIVE_CAP = 100;

/** A workspace name's length, trimmed. */
export const WORKSPACE_NAME_MAX = 80; // = WORKSPACE_NAME_MAX_LENGTH (lib/validation/workspaces.ts)

/** An archive deactivates every class in one transaction, so it may take longer than one write. */
const ARCHIVE_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

/**
 * The fixed set an owner may do in their workspace (D-W38 item 3). Code, not
 * configuration: no matrix row, no staff role and no invitation of staff can
 * widen or narrow it. Reads need only `resolveWorkspaceAccess` (owning it).
 */
export const WORKSPACE_OWNER_CAPABILITIES = [
  "workspace.classes.manage",
  "workspace.sessions.manage",
  "workspace.rooms.manage",
  "workspace.archive",
] as const;

export type WorkspaceCapability = (typeof WORKSPACE_OWNER_CAPABILITIES)[number];

/** What a workspace decision is made from — resolved on the server, never posted. */
export type WorkspaceAccess = {
  actorUserId: string;
  centerId: string;
  ownerUserId: string;
  kind: CenterKind;
  archivedAt: Date | null;
  /** The actor's ACTIVE TEACHER membership at the workspace, or null. */
  membershipId: string | null;
};

/**
 * Which workspace rows may be resolved at all: PERSONAL, not deleted, in an
 * accessible lifecycle state. An archived workspace is still resolved — it is
 * read-only, not gone (D-W28).
 */
export const LIVE_WORKSPACE = {
  ...PERSONAL_ONLY,
  deletedAt: null,
  lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] },
} satisfies Prisma.CenterWhereInput;

/** The workspaces `userId` owns — through their personal organization only. */
export function ownedWorkspaceWhere(userId: string): Prisma.CenterWhereInput {
  return { ...LIVE_WORKSPACE, organization: { ownerUserId: userId } };
}

/**
 * The owner's access to one workspace, or `null` for anyone else and for any
 * id that is not a live PERSONAL workspace. Both ids come from the server: the
 * session's user and the route's workspace id.
 */
export async function resolveWorkspaceAccess(
  db: Db,
  actorUserId: string,
  workspaceId: string,
): Promise<WorkspaceAccess | null> {
  if (!actorUserId || !workspaceId) return null;
  const row = await db.center.findFirst({
    where: { id: workspaceId, ...ownedWorkspaceWhere(actorUserId) },
    select: {
      id: true,
      kind: true,
      archivedAt: true,
      organization: { select: { ownerUserId: true } },
      memberships: {
        where: { userId: actorUserId, role: TEACHER, active: true },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!row || !row.organization.ownerUserId) return null;
  return {
    actorUserId,
    centerId: row.id,
    ownerUserId: row.organization.ownerUserId,
    kind: row.kind,
    archivedAt: row.archivedAt,
    membershipId: row.memberships[0]?.id ?? null,
  };
}

/**
 * **The one workspace decision** (D-W38 item 3): the actor owns the
 * workspace, holds its ACTIVE TEACHER membership, and the action is one of
 * `WORKSPACE_OWNER_CAPABILITIES`. Deny by default.
 */
export function workspaceCan(ctx: { workspace: WorkspaceAccess }, action: WorkspaceCapability): boolean {
  const access = ctx.workspace;
  return (
    access.kind === "PERSONAL" &&
    access.actorUserId === access.ownerUserId &&
    access.membershipId !== null &&
    (WORKSPACE_OWNER_CAPABILITIES as readonly string[]).includes(action)
  );
}

export type WorkspaceWriteRefusal = "premiumRequired" | "workspaceArchived";

/**
 * What every workspace write needs beyond `workspaceCan`: the owner premium
 * now (D-W15 — worked out on this request, no stored flag, no cron) and the
 * workspace not archived (D-W28). Reads never call it.
 */
export async function assertWorkspaceWritable(
  db: Db,
  access: WorkspaceAccess,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; error: WorkspaceWriteRefusal }> {
  if (!(await requirePremium(db, access.ownerUserId, now)).ok) return { ok: false, error: "premiumRequired" };
  if (access.archivedAt) return { ok: false, error: "workspaceArchived" };
  return { ok: true };
}

export type WorkspaceAuthError = "notFound" | "forbidden" | WorkspaceWriteRefusal;

/** resolve → `workspaceCan` → `assertWorkspaceWritable`, the gate every writer below opens with. */
async function authorizeWrite(
  db: Db,
  actorUserId: string,
  workspaceId: string,
  action: WorkspaceCapability,
  now: Date,
): Promise<{ ok: true; access: WorkspaceAccess } | { ok: false; error: WorkspaceAuthError }> {
  const access = await resolveWorkspaceAccess(db, actorUserId, workspaceId);
  if (!access) return { ok: false, error: "notFound" };
  if (!workspaceCan({ workspace: access }, action)) return { ok: false, error: "forbidden" };
  const writable = await assertWorkspaceWritable(db, access, now);
  if (!writable.ok) return writable;
  return { ok: true, access };
}

/** Locks the teacher's `User` row — the cap's serialisation point (D-W21, like D-W36's assistant slots). */
async function lockTeacher(tx: Tx, userId: string) {
  const rows = await tx.$queryRaw<
    { id: string; firstName: string; lastName: string; email: string | null; phone: string | null }[]
  >`SELECT "id", "firstName", "lastName", "email", "phone" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** How many ACTIVE (not archived) workspaces `userId` owns — what the cap counts. */
export function countActiveWorkspaces(db: Db, userId: string): Promise<number> {
  return db.center.count({ where: { ...ownedWorkspaceWhere(userId), archivedAt: null } });
}

/** Whether `userId` owns any workspace, archived included — the Teacher experience's second source (D-W38 item 11). */
export async function ownsAnyWorkspace(db: Db, userId: string): Promise<boolean> {
  return (await db.center.count({ where: ownedWorkspaceWhere(userId), take: 1 })) > 0;
}

/** A workspace name, trimmed; `null` when blank or too long. */
export function normalizeWorkspaceName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= WORKSPACE_NAME_MAX ? name : null;
}

// ── Create, rename, archive, unarchive ─────────────────────────────────────

export type CreateWorkspaceResult =
  | { ok: true; workspaceId: string }
  | { ok: false; error: "invalidName" | "notFound" | "premiumRequired" }
  | { ok: false; error: "workspaceCapReached"; active: number };

/**
 * A premium teacher creates a workspace (D-W38 items 2, 4, 5). One
 * transaction under the lock on their `User` row: premium re-read, the ACTIVE
 * workspaces counted **after** the lock is held (so two concurrent creations
 * at the limit serialise and the second is refused), then
 * `createPersonalWorkspace` (lib/db/platform.ts) and the audit row.
 */
export async function createWorkspace(
  db: PrismaClient,
  actorUserId: string,
  input: { name: string },
  now: Date = new Date(),
): Promise<CreateWorkspaceResult> {
  const name = normalizeWorkspaceName(input.name);
  if (!name) return { ok: false, error: "invalidName" };
  return db.$transaction(async (tx): Promise<CreateWorkspaceResult> => {
    const owner = await lockTeacher(tx, actorUserId);
    if (!owner) return { ok: false, error: "notFound" };
    if (!(await requirePremium(tx, actorUserId, now)).ok) return { ok: false, error: "premiumRequired" };
    const active = await countActiveWorkspaces(tx, actorUserId);
    if (active >= WORKSPACE_ACTIVE_CAP) return { ok: false, error: "workspaceCapReached", active };
    const rows = await createPersonalWorkspace(tx, { owner, name });
    await writeAuditRow(tx, {
      centerId: rows.center.id,
      actorUserId,
      action: "workspace.create",
      entityType: "Center",
      entityId: rows.center.id,
      after: {
        kind: "PERSONAL",
        organizationId: rows.organizationId,
        organizationCreated: rows.organizationCreated,
        membershipId: rows.membershipId,
      },
    });
    return { ok: true, workspaceId: rows.center.id };
  }, WRITE_TRANSACTION_OPTIONS);
}

export type RenameWorkspaceResult = { ok: true } | { ok: false; error: WorkspaceAuthError | "invalidName" };

/** Settings → Rename. A write like any other: premium now and not archived. Audited, ids only. */
export async function renameWorkspace(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  rawName: string,
  now: Date = new Date(),
): Promise<RenameWorkspaceResult> {
  const name = normalizeWorkspaceName(rawName);
  if (!name) return { ok: false, error: "invalidName" };
  return db.$transaction(async (tx): Promise<RenameWorkspaceResult> => {
    const gate = await authorizeWrite(tx, actorUserId, workspaceId, "workspace.archive", now);
    if (!gate.ok) return gate;
    await tx.center.update({ where: { id: gate.access.centerId }, data: { name } });
    await writeAuditRow(tx, {
      centerId: gate.access.centerId,
      actorUserId,
      action: "workspace.rename",
      entityType: "Center",
      entityId: gate.access.centerId,
    });
    return { ok: true };
  }, WRITE_TRANSACTION_OPTIONS);
}

export type ArchiveWorkspaceResult =
  | { ok: true; classesDeactivated: number; sessionsDeleted: number; sessionsCancelled: number }
  | { ok: false; error: "notFound" | "forbidden" | "alreadyArchived" };

/**
 * Archive (D-W28). Needs **no** premium — reducing what is active is never
 * gated. In one transaction under the teacher's lock: every active class is
 * deactivated through the class engine's own deactivation
 * (`deactivateClassInTransaction`: pristine future sessions deleted, sessions
 * with records cancelled, each audited `classGroup.deactivate`), then the
 * archive flag is set and audited. History is untouched, and the workspace
 * stops counting toward the cap.
 */
export async function archiveWorkspace(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  now: Date = new Date(),
): Promise<ArchiveWorkspaceResult> {
  return db.$transaction(async (tx): Promise<ArchiveWorkspaceResult> => {
    if (!(await lockTeacher(tx, actorUserId))) return { ok: false, error: "notFound" };
    const access = await resolveWorkspaceAccess(tx, actorUserId, workspaceId);
    if (!access) return { ok: false, error: "notFound" };
    if (!workspaceCan({ workspace: access }, "workspace.archive")) return { ok: false, error: "forbidden" };
    if (access.archivedAt) return { ok: false, error: "alreadyArchived" };

    const classes = await tx.classGroup.findMany({
      where: { centerId: access.centerId, active: true },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    let classesDeactivated = 0;
    let sessionsDeleted = 0;
    let sessionsCancelled = 0;
    for (const row of classes) {
      const result = await deactivateClassInTransaction(tx, access.centerId, row.id, { actorUserId, now });
      if (!result.ok) continue;
      classesDeactivated += 1;
      sessionsDeleted += result.deleted;
      sessionsCancelled += result.cancelled;
    }
    await tx.center.update({
      where: { id: access.centerId },
      data: { archivedAt: now, archivedByUserId: actorUserId },
    });
    await writeAuditRow(tx, {
      centerId: access.centerId,
      actorUserId,
      action: "workspace.archive",
      entityType: "Center",
      entityId: access.centerId,
      before: { archivedAt: null },
      after: { archivedAt: now.toISOString(), classesDeactivated, sessionsDeleted, sessionsCancelled },
    });
    return { ok: true, classesDeactivated, sessionsDeleted, sessionsCancelled };
  }, ARCHIVE_TRANSACTION_OPTIONS);
}

export type UnarchiveWorkspaceResult =
  | { ok: true }
  | { ok: false; error: "notFound" | "forbidden" | "premiumRequired" | "notArchived" }
  | { ok: false; error: "workspaceCapReached"; active: number };

/**
 * Unarchive (D-W28): premium now, and refused at the cap with the count —
 * re-counted under the teacher's lock. Classes stay deactivated; the teacher
 * reactivates each one (the R4 reactivation recreates its sessions).
 */
export async function unarchiveWorkspace(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  now: Date = new Date(),
): Promise<UnarchiveWorkspaceResult> {
  return db.$transaction(async (tx): Promise<UnarchiveWorkspaceResult> => {
    if (!(await lockTeacher(tx, actorUserId))) return { ok: false, error: "notFound" };
    const access = await resolveWorkspaceAccess(tx, actorUserId, workspaceId);
    if (!access) return { ok: false, error: "notFound" };
    if (!workspaceCan({ workspace: access }, "workspace.archive")) return { ok: false, error: "forbidden" };
    if (!(await requirePremium(tx, actorUserId, now)).ok) return { ok: false, error: "premiumRequired" };
    if (!access.archivedAt) return { ok: false, error: "notArchived" };
    const active = await countActiveWorkspaces(tx, actorUserId);
    if (active >= WORKSPACE_ACTIVE_CAP) return { ok: false, error: "workspaceCapReached", active };
    await tx.center.update({ where: { id: access.centerId }, data: { archivedAt: null, archivedByUserId: null } });
    await writeAuditRow(tx, {
      centerId: access.centerId,
      actorUserId,
      action: "workspace.unarchive",
      entityType: "Center",
      entityId: access.centerId,
      before: { archivedAt: access.archivedAt.toISOString() },
      after: { archivedAt: null },
    });
    return { ok: true };
  }, WRITE_TRANSACTION_OPTIONS);
}

// ── Reads ──────────────────────────────────────────────────────────────────

export type WorkspaceListRow = {
  id: string;
  name: string;
  archivedAt: Date | null;
  activeClasses: number;
  createdAt: Date;
};

/** The teacher's own workspaces: active first, then archived, each by name. */
export async function listOwnedWorkspaces(db: Db, userId: string): Promise<WorkspaceListRow[]> {
  const rows = await db.center.findMany({
    where: ownedWorkspaceWhere(userId),
    select: {
      id: true,
      name: true,
      archivedAt: true,
      createdAt: true,
      _count: { select: { classGroups: { where: { active: true } } } },
    },
  });
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      activeClasses: row._count.classGroups,
    }))
    .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.name.localeCompare(b.name));
}

/** The workspace's hidden default room — every class and session uses it (the engine requires a primary room). */
export async function workspaceRoomId(db: Db, centerId: string): Promise<string | null> {
  const room = await db.room.findFirst({
    where: { centerId, active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return room?.id ?? null;
}

// ── Classes ────────────────────────────────────────────────────────────────

/** The forced cut (D-W24, CLAUDE.md rule 15): PERCENTAGE 0, so the teacher's share is the whole amount. */
export const WORKSPACE_CUT = { centerShareType: "PERCENTAGE", centerShareValue: 0 } as const satisfies {
  centerShareType: ShareType;
  centerShareValue: number;
};

/** Refuses any posted cut other than the forced one (`workspaceCutFixed`); nothing posted is fine. */
export function workspaceCutError(cut: { centerShareType?: ShareType | null; centerShareValue?: number | null }): "workspaceCutFixed" | null {
  const typeGiven = cut.centerShareType !== undefined && cut.centerShareType !== null;
  const valueGiven = cut.centerShareValue !== undefined && cut.centerShareValue !== null;
  if (typeGiven && cut.centerShareType !== WORKSPACE_CUT.centerShareType) return "workspaceCutFixed";
  if (valueGiven && cut.centerShareValue !== WORKSPACE_CUT.centerShareValue) return "workspaceCutFixed";
  return null;
}

/** The forced class fields: the owner teaches, the hidden room, the 0 cut, never browsable or bookable. */
function forcedClassFields(ownerUserId: string, roomId: string) {
  return {
    teacherId: ownerUserId,
    roomId,
    extraRoomIds: [] as string[],
    ...WORKSPACE_CUT,
    acceptsNewStudents: false,
    requiresConfirmation: false,
    sessionBookingMode: "OFF" as const,
    maxBookingSeats: null,
  };
}

export type WorkspaceClassInput = {
  educationSystemId: string | null;
  gradeId: string | null;
  subjectId: string | null;
  /** Piastres per session. */
  price: number;
  lateThresholdMinutes: number;
  startDate: Date;
  endDate: Date;
  /** Only ever PERCENTAGE 0 — anything else is refused (`workspaceCutFixed`). */
  centerShareType?: ShareType | null;
  centerShareValue?: number | null;
};

export type WorkspaceCatalogError = "educationSystemNotFound" | "gradeNotFound" | "subjectNotFound" | "subjectNotInGrade";

/**
 * The class's catalogue entries, against the **global** catalogue (a
 * workspace picks nothing): each must exist and be active — unless it is the
 * class's current value, which may stay (as at a branch, R8) — and the pair
 * must be linked (`isWorkspacePairOffered`).
 */
async function workspaceCatalogError(
  db: Db,
  ids: { educationSystemId: string | null; gradeId: string | null; subjectId: string | null },
  current: { educationSystemId: string | null; gradeId: string | null; subjectId: string | null } | null = null,
): Promise<WorkspaceCatalogError | null> {
  const [system, grade, subject] = await Promise.all([
    ids.educationSystemId ? db.catalogEducationSystem.findUnique({ where: { id: ids.educationSystemId }, select: { active: true } }) : null,
    ids.gradeId ? db.catalogGrade.findUnique({ where: { id: ids.gradeId }, select: { active: true } }) : null,
    ids.subjectId ? db.catalogSubject.findUnique({ where: { id: ids.subjectId }, select: { active: true } }) : null,
  ]);
  const usable = (id: string | null, row: { active: boolean } | null, currentId: string | null | undefined) =>
    id === null || (row !== null && (row.active || id === currentId));
  if (!usable(ids.educationSystemId, system, current?.educationSystemId)) return "educationSystemNotFound";
  if (!usable(ids.gradeId, grade, current?.gradeId)) return "gradeNotFound";
  if (!usable(ids.subjectId, subject, current?.subjectId)) return "subjectNotFound";
  const pairChanged = !current || current.gradeId !== ids.gradeId || current.subjectId !== ids.subjectId;
  if (ids.gradeId && ids.subjectId && pairChanged && !(await isWorkspacePairOffered(db, ids.gradeId, ids.subjectId))) {
    return "subjectNotInGrade";
  }
  return null;
}

type EngineOptions = { confirmConflicts: boolean; locale?: string; now?: Date };

function priceError(price: number): "invalidPrice" | null {
  return Number.isInteger(price) && price >= 0 && price <= MAX_PRICE_PIASTRES ? null : "invalidPrice";
}

/** A new workspace class, its weekly slots and every session of its period — the class engine's one create. */
export async function createWorkspaceClass(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  input: WorkspaceClassInput & { slots: ClassSlot[] },
  options: EngineOptions,
) {
  const now = options.now ?? new Date();
  const gate = await authorizeWrite(db, actorUserId, workspaceId, "workspace.classes.manage", now);
  if (!gate.ok) return gate;
  const cutError = workspaceCutError(input);
  if (cutError) return { ok: false as const, error: cutError };
  const catalogError = await workspaceCatalogError(db, input);
  if (catalogError) return { ok: false as const, error: catalogError };
  const roomId = await workspaceRoomId(db, gate.access.centerId);
  if (!roomId) return { ok: false as const, error: "noPrimary" as const };
  return createClassWithSessions(
    db,
    gate.access.centerId,
    {
      ...forcedClassFields(gate.access.ownerUserId, roomId),
      educationSystemId: input.educationSystemId,
      gradeId: input.gradeId,
      subjectId: input.subjectId,
      price: input.price,
      lateThresholdMinutes: input.lateThresholdMinutes,
      startDate: input.startDate,
      endDate: input.endDate,
      slots: input.slots,
    },
    { ...options, now, actorUserId },
  );
}

/** Edits a workspace class (period, price, late threshold, catalogue) through the engine's one update. */
export async function updateWorkspaceClass(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  classGroupId: string,
  input: WorkspaceClassInput,
  options: EngineOptions,
) {
  const now = options.now ?? new Date();
  const gate = await authorizeWrite(db, actorUserId, workspaceId, "workspace.classes.manage", now);
  if (!gate.ok) return gate;
  const cutError = workspaceCutError(input);
  if (cutError) return { ok: false as const, error: cutError };
  const existing = await db.classGroup.findFirst({
    where: { id: classGroupId, centerId: gate.access.centerId },
    select: { roomId: true, educationSystemId: true, gradeId: true, subjectId: true },
  });
  if (!existing) return { ok: false as const, error: "notFound" as const };
  const catalogError = await workspaceCatalogError(db, input, existing);
  if (catalogError) return { ok: false as const, error: catalogError };
  const roomId = existing.roomId ?? (await workspaceRoomId(db, gate.access.centerId));
  if (!roomId) return { ok: false as const, error: "noPrimary" as const };
  return updateClassWithSessions(
    db,
    gate.access.centerId,
    classGroupId,
    {
      ...forcedClassFields(gate.access.ownerUserId, roomId),
      educationSystemId: input.educationSystemId,
      gradeId: input.gradeId,
      subjectId: input.subjectId,
      price: input.price,
      lateThresholdMinutes: input.lateThresholdMinutes,
      startDate: input.startDate,
      endDate: input.endDate,
    },
    { ...options, now, actorUserId },
  );
}

/** Deactivate (the R4 rule) or reactivate (refused once the period ended) a workspace class. */
export async function setWorkspaceClassActive(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  classGroupId: string,
  active: boolean,
  options: EngineOptions,
) {
  const now = options.now ?? new Date();
  const gate = await authorizeWrite(db, actorUserId, workspaceId, "workspace.classes.manage", now);
  if (!gate.ok) return gate;
  if (!active) return deactivateClass(db, gate.access.centerId, classGroupId, { actorUserId, now });
  return reactivateClass(db, gate.access.centerId, classGroupId, { ...options, now, actorUserId });
}

/** Deletes a workspace class that never ran — the engine's own blockers decide. */
export async function deleteWorkspaceClass(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  classGroupId: string,
  now: Date = new Date(),
) {
  const gate = await authorizeWrite(db, actorUserId, workspaceId, "workspace.classes.manage", now);
  if (!gate.ok) return gate;
  return deleteClass(db, gate.access.centerId, classGroupId, { actorUserId, now });
}

export type WorkspaceSlotChange =
  | { kind: "add"; classGroupId: string; slot: ClassSlot }
  | { kind: "update"; scheduleId: string; classGroupId: string; slot: ClassSlot }
  | { kind: "remove"; scheduleId: string };

/** Adds, moves or removes one weekly slot and resyncs the class's future sessions. */
export async function writeWorkspaceClassSlot(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  change: WorkspaceSlotChange,
  options: EngineOptions,
) {
  const now = options.now ?? new Date();
  const gate = await authorizeWrite(db, actorUserId, workspaceId, "workspace.classes.manage", now);
  if (!gate.ok) return gate;
  if (change.kind === "add") {
    const found = await db.classGroup.count({ where: { id: change.classGroupId, centerId: gate.access.centerId } });
    if (found === 0) return { ok: false as const, error: "notFound" as const };
  }
  return writeClassSlot(db, gate.access.centerId, change, { ...options, now, actorUserId });
}

// ── Sessions ───────────────────────────────────────────────────────────────

export type WorkspaceSessionInput =
  | { kind: "extra"; classGroupId: string; date: Date; startTime: string; endTime: string }
  | { kind: "oneOff"; title: string; price: number; date: Date; startTime: string; endTime: string };

/**
 * An extra session for a workspace class, or a one-time session — the
 * engine's two manual-session writers, with the owner, the hidden room and
 * (one-time) the forced 0 cut. A workspace one-time session carries no
 * grade or subject in W8a (D-W38).
 */
export async function createWorkspaceSession(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  input: WorkspaceSessionInput,
  options: EngineOptions,
) {
  const now = options.now ?? new Date();
  const gate = await authorizeWrite(db, actorUserId, workspaceId, "workspace.sessions.manage", now);
  if (!gate.ok) return gate;
  const roomId = await workspaceRoomId(db, gate.access.centerId);
  if (!roomId) return { ok: false as const, error: "noPrimary" as const };
  const slot = {
    teacherId: gate.access.ownerUserId,
    roomId,
    extraRoomIds: [],
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
  };
  const engine = { confirmConflicts: options.confirmConflicts, actorUserId, now, locale: options.locale };
  if (input.kind === "extra") {
    return createManualSession(db, gate.access.centerId, { ...slot, classGroupId: input.classGroupId }, engine);
  }
  const invalid = priceError(input.price);
  if (invalid) return { ok: false as const, error: invalid };
  return createOneOffSession(
    db,
    gate.access.centerId,
    { ...slot, title: input.title, subjectId: null, gradeId: null, price: input.price, ...WORKSPACE_CUT },
    engine,
  );
}

/**
 * Reschedule (M15, R3): the replacement keeps the original's room set (the
 * hidden room); the conflict policy is the workspace's (WARN). Audited
 * `session.reschedule` as at a branch.
 */
export async function rescheduleWorkspaceSession(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  sessionId: string,
  next: { date: Date; startTime: string; endTime: string },
  options: EngineOptions,
) {
  const now = options.now ?? new Date();
  const gate = await authorizeWrite(db, actorUserId, workspaceId, "workspace.sessions.manage", now);
  if (!gate.ok) return gate;
  const centerId = gate.access.centerId;
  const [before, settings] = await Promise.all([
    db.session.findFirst({ where: { id: sessionId, centerId }, select: { date: true, startTime: true, endTime: true, roomId: true } }),
    db.centerSettings.findUnique({ where: { centerId }, select: { scheduleConflictPolicy: true } }),
  ]);
  if (!before) return { ok: false as const, error: "notFound" as const };
  const policy = settings?.scheduleConflictPolicy ?? "WARN";
  const result = await rescheduleSession(db, centerId, sessionId, next, policy, options.locale ?? "en", {
    confirmConflicts: options.confirmConflicts,
    actorUserId,
    now,
  });
  if (!result.ok) return { ...result, policy };
  await writeAuditRow(db, {
    centerId,
    actorUserId,
    action: "session.reschedule",
    entityType: "Session",
    entityId: sessionId,
    before: { date: before.date.toISOString(), startTime: before.startTime, endTime: before.endTime, roomId: before.roomId },
    after: {
      date: result.session.date.toISOString(),
      startTime: next.startTime,
      endTime: next.endTime,
      roomId: result.session.roomId,
      newSessionId: result.session.id,
    },
  });
  return { ...result, policy };
}

/** Cancel (M10) — the engine's own rules (refused with payments, once closed, twice). Audited `session.cancel`. */
export async function cancelWorkspaceSession(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  sessionId: string,
  now: Date = new Date(),
) {
  const gate = await authorizeWrite(db, actorUserId, workspaceId, "workspace.sessions.manage", now);
  if (!gate.ok) return gate;
  const result = await cancelSession(db, gate.access.centerId, sessionId, { now });
  if (!result.ok) return result;
  await writeAuditRow(db, {
    centerId: gate.access.centerId,
    actorUserId,
    action: "session.cancel",
    entityType: "Session",
    entityId: sessionId,
    before: { status: "SCHEDULED" },
    after: { status: "CANCELLED" },
  });
  return result;
}

/** Deletes an extra or one-time session that never ran — the engine's own blockers decide. */
export async function deleteWorkspaceSession(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  sessionId: string,
  now: Date = new Date(),
) {
  const gate = await authorizeWrite(db, actorUserId, workspaceId, "workspace.sessions.manage", now);
  if (!gate.ok) return gate;
  return deleteManualSession(db, gate.access.centerId, sessionId, { actorUserId, now });
}

// ── Page reads (every one scoped by the workspace's centerId) ──────────────

const CATALOG_NAME = { select: { nameAr: true, nameEn: true } } as const;

/** The workspace's classes, active first: their catalogue names, weekly slots and upcoming session count. */
export function workspaceClasses(db: Db, centerId: string, today: Date) {
  return db.classGroup.findMany({
    where: { centerId },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      active: true,
      price: true,
      startDate: true,
      endDate: true,
      educationSystemId: true,
      gradeId: true,
      subjectId: true,
      lateThresholdMinutes: true,
      subject: CATALOG_NAME,
      grade: CATALOG_NAME,
      educationSystem: CATALOG_NAME,
      schedules: { select: { id: true, dayOfWeek: true, startTime: true, endTime: true }, orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] },
      _count: { select: { sessions: { where: { date: { gte: today }, status: "SCHEDULED", rescheduledToId: null } } } },
    },
  });
}

export type WorkspaceClassRow = Awaited<ReturnType<typeof workspaceClasses>>[number];

/** One workspace class, or null when the id is not this workspace's. */
export async function workspaceClass(db: Db, centerId: string, classId: string, today: Date) {
  const rows = await db.classGroup.findMany({
    where: { centerId, id: classId },
    select: {
      id: true,
      active: true,
      price: true,
      startDate: true,
      endDate: true,
      educationSystemId: true,
      gradeId: true,
      subjectId: true,
      lateThresholdMinutes: true,
      subject: CATALOG_NAME,
      grade: CATALOG_NAME,
      educationSystem: CATALOG_NAME,
      schedules: { select: { id: true, dayOfWeek: true, startTime: true, endTime: true }, orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] },
      _count: { select: { sessions: { where: { date: { gte: today }, status: "SCHEDULED", rescheduledToId: null } } } },
    },
    take: 1,
  });
  return rows[0] ?? null;
}

/**
 * The workspace's sessions from `from` on (the teacher's own window floor,
 * `teacherPortalHistoryFloor`, when set), oldest first, a session moved away
 * left out (U2). `classId` narrows to one class.
 */
export function workspaceSessions(db: Db, centerId: string, options: { from: Date | null; classId?: string; take?: number }) {
  return db.session.findMany({
    where: {
      centerId,
      rescheduledToId: null,
      ...(options.from ? { date: { gte: options.from } } : {}),
      ...(options.classId ? { classGroupId: options.classId } : {}),
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    take: options.take ?? 500,
    select: {
      id: true,
      date: true,
      startTime: true,
      endTime: true,
      status: true,
      rescheduledToId: true,
      closedAt: true,
      timezone: true,
      title: true,
      isManual: true,
      classGroupId: true,
      priceSnapshot: true,
      subject: CATALOG_NAME,
      grade: CATALOG_NAME,
      classGroup: { select: { subject: CATALOG_NAME, grade: CATALOG_NAME } },
      rescheduledFrom: { select: { date: true, startTime: true } },
    },
  });
}

export type WorkspaceSessionRow = Awaited<ReturnType<typeof workspaceSessions>>[number];
