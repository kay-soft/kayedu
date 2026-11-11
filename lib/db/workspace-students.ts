import type { EnrollmentStatus, Prisma, PrismaClient, WorkspaceInvitationStatus } from "@prisma/client";

// Relative imports on purpose: `npm run check:workspaces` runs this module
// directly, outside the Next.js runtime (the lib/db/workspaces.ts reasoning).
// The client is injected.
import { dedupeKeys } from "../notifications/kinds.ts";
import { normalizePhone } from "../phone.ts";
import { checkRateLimits } from "../rate-limit.ts";
import { writeAuditRow } from "./audit-row.ts";
import { createPlaceholderPerson, deletePersonIfOrphaned } from "./identity.ts";
import { queueNotificationEmails } from "../notify/email.ts";
import { workspaceTeacherNames } from "./notifications.ts";
import { claimClassSeat } from "./reservations.ts";
import { WRITE_TRANSACTION_OPTIONS } from "./session-lifecycle.ts";
import { claimStudentCode } from "./students.ts";
import { scopedWhere } from "./tenant-scope.ts";
import {
  LIVE_WORKSPACE,
  authorizeWrite,
  ownedWorkspaceWhere,
  resolveWorkspaceAccess,
  workspaceCan,
  type WorkspaceAccess,
  type WorkspaceAuthError,
} from "./workspaces.ts";

/**
 * PERSONAL-workspace students and invitations (W8b, D-W22, D-W27, D-W39;
 * docs/02-architecture.md §18). A workspace student is a `StudentProfile` at
 * the workspace centre, created the way a centre adds one — a local record
 * (rule 4) with its own code — behind a **placeholder** `User` that never
 * holds a global contact (`createPlaceholderPerson`, D-W39 item 2).
 *
 * **One answer, matched or not (D-W27).** The typed phone is matched against
 * `User.phone` **only**, of an account with a login (`authId` set) — never
 * `contactPhone`, never another tenant's profile phone. A match writes a
 * PENDING `WorkspaceInvitation` and a `WORKSPACE_INVITATION` notice in the
 * add's own transaction; no match writes nothing more. The teacher's result,
 * the audit row and the rate-limit count are the same either way, and the
 * teacher's reads say only "Linked" or "Not linked" — never a pending
 * invitation, and never the account's name, email or id.
 *
 * **Accepting** moves the profile from its placeholder to the account and
 * removes the placeholder when it holds nothing else, in one transaction
 * (D-W39 item 7). This replaces "the claim merge path": `approveAccountClaim`
 * gives a login to a staff-created person who has no account; here the
 * account already exists, so the profile moves to it instead.
 *
 * Authority is the workspace's own: `authorizeWrite` (owner, the
 * `workspace.students.manage` capability, premium now, not archived) on every
 * add, invitation and enrolment write; cancelling an invitation reduces
 * access, so it needs ownership only (the D-W37 precedent).
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;

const STUDENTS = "workspace.students.manage" as const;
const PENDING: WorkspaceInvitationStatus = "PENDING";
const ACTIVE_ENROLLMENT: EnrollmentStatus = "ACTIVE";
const LIVE_ENROLLMENT_STATUSES: EnrollmentStatus[] = ["ACTIVE", "BLOCKED"];

/** D-W39 item 6: "Invite again" at most once per profile in this window (the add counts as the first invitation). */
export const INVITE_AGAIN_WINDOW_MS = 24 * 60 * 60_000;

/** The audit actions this module writes — ids only (D-20). */
export const WORKSPACE_STUDENT_AUDIT = {
  add: "workspace.student.add",
  invite: "workspace.student.invite",
  cancel: "workspace.invitation.cancel",
  accept: "workspace.invitation.accept",
  decline: "workspace.invitation.decline",
} as const;

/** A name part's length, trimmed (the people forms' own limit). */
export const WORKSPACE_STUDENT_NAME_MAX = 60;

// ── Matching and inviting ───────────────────────────────────────────────────

/**
 * Match, invite and notify — **one statement, run on every add and every
 * "Invite again", match or not** (D-W27, D-W39 item 3). The account a phone
 * addresses is `User.phone` equal to the stored E.164 form, with a login
 * (`"authId" IS NOT NULL`); the workspace's own teacher and an account
 * already holding a profile in this workspace count as no match. On a match
 * the statement inserts the PENDING invitation and its `WORKSPACE_INVITATION`
 * notice (ids only; the database's payload CHECK applies, and the dedupe key
 * is `dedupeKeys.workspaceInvitation`); otherwise it inserts nothing. Because
 * the same single round trip runs either way, the add's timing does not
 * depend on whether an account exists. The email hook (`EMAIL_ENABLED`, off)
 * is told of a written notice exactly as `notify` tells it.
 */
async function inviteIfMatched(tx: Tx, access: WorkspaceAccess, studentProfileId: string, phone: string | null) {
  const dedupePrefix = dedupeKeys.workspaceInvitation("");
  const rows = await tx.$queryRaw<{ invitationId: string; targetUserId: string }[]>`
    WITH target AS (
      SELECT u."id" FROM "User" u
      WHERE u."phone" = ${phone} AND u."authId" IS NOT NULL AND u."id" <> ${access.ownerUserId}
        AND NOT EXISTS (SELECT 1 FROM "StudentProfile" p WHERE p."centerId" = ${access.centerId} AND p."userId" = u."id")
      LIMIT 1
    ), invitation AS (
      INSERT INTO "WorkspaceInvitation" ("id", "centerId", "studentProfileId", "targetUserId", "status")
      SELECT gen_random_uuid()::text, ${access.centerId}, ${studentProfileId}, target."id", 'PENDING'::"WorkspaceInvitationStatus"
      FROM target
      RETURNING "id", "targetUserId"
    ), notice AS (
      INSERT INTO "Notification" ("id", "userId", "kind", "centerId", "payload", "dedupeKey")
      SELECT gen_random_uuid()::text, invitation."targetUserId", 'WORKSPACE_INVITATION'::"NotificationKind", ${access.centerId},
             jsonb_build_object('invitationId', invitation."id"), ${dedupePrefix} || invitation."id"
      FROM invitation
      ON CONFLICT ("userId", "dedupeKey") DO NOTHING
      RETURNING "id"
    )
    SELECT invitation."id" AS "invitationId", invitation."targetUserId" AS "targetUserId" FROM invitation`;
  queueNotificationEmails(rows.map((row) => ({ userId: row.targetUserId, kind: "WORKSPACE_INVITATION" })));
}

/** Re-runs the write gate on the transaction, so a change since the pre-check cannot slip through. */
async function regate(tx: Tx, actorUserId: string, workspaceId: string, now: Date) {
  return authorizeWrite(tx, actorUserId, workspaceId, STUDENTS, now);
}

// ── Adding ──────────────────────────────────────────────────────────────────

export type WorkspaceStudentInput = {
  firstName: string;
  lastName: string;
  /** As typed; normalised through lib/phone.ts. */
  phone: string;
  gradeId: string | null;
};

export type AddWorkspaceStudentResult =
  | { ok: true; studentProfileId: string }
  | { ok: false; error: WorkspaceAuthError | "rateLimited" | "invalidPhone" | "duplicatePhone" | "gradeNotFound" | "nameRequired" };

type AddOptions = { now?: Date; source?: "typed" | "copied" };

/**
 * Adds a student to a workspace (D-W39 item 1). The result is `{ ok, studentProfileId }`
 * whether or not an account matched; the audit row is one shape; a match adds
 * only the invitation and its notice, inside the same transaction.
 */
export async function addWorkspaceStudent(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  input: WorkspaceStudentInput,
  options: AddOptions = {},
): Promise<AddWorkspaceStudentResult> {
  const now = options.now ?? new Date();
  const gate = await authorizeWrite(db, actorUserId, workspaceId, STUDENTS, now);
  if (!gate.ok) return gate;
  // Counted before anything is looked up, valid or not (D-W39 item 13).
  if (!(await checkRateLimits([{ name: "workspaceStudentAddPerUser", key: actorUserId }]))) {
    return { ok: false, error: "rateLimited" };
  }
  const firstName = input.firstName.trim().slice(0, WORKSPACE_STUDENT_NAME_MAX);
  const lastName = input.lastName.trim().slice(0, WORKSPACE_STUDENT_NAME_MAX);
  if (!firstName || !lastName) return { ok: false, error: "nameRequired" };
  const phone = normalizePhone(input.phone);
  if (!phone) return { ok: false, error: "invalidPhone" };
  if (input.gradeId) {
    const grade = await db.catalogGrade.findUnique({ where: { id: input.gradeId }, select: { active: true } });
    if (!grade?.active) return { ok: false, error: "gradeNotFound" };
  }

  return db.$transaction(async (tx): Promise<AddWorkspaceStudentResult> => {
    const again = await regate(tx, actorUserId, workspaceId, now);
    if (!again.ok) return again;
    const access = again.access;
    // The duplicate rule, inside this workspace only: the same phone on one of
    // its own profiles. Nothing outside the workspace is read for it.
    const duplicate = await tx.studentProfile.count({ where: scopedWhere(access.centerId, { phone }) });
    if (duplicate > 0) return { ok: false, error: "duplicatePhone" };

    const placeholder = await createPlaceholderPerson({ firstName, lastName, locale: "ar" }, tx);
    const studentCode = await claimStudentCode(tx, access.centerId);
    const profile = await tx.studentProfile.create({
      data: {
        userId: placeholder.id,
        centerId: access.centerId,
        studentCode,
        gradeId: input.gradeId,
        firstName,
        lastName,
        phone,
        // A teacher-typed record is complete at creation, like a desk-registered one (M18).
        profileCompletedAt: now,
      },
      select: { id: true },
    });
    await writeAuditRow(tx, {
      centerId: access.centerId,
      actorUserId,
      action: WORKSPACE_STUDENT_AUDIT.add,
      entityType: "StudentProfile",
      entityId: profile.id,
      after: { gradeId: input.gradeId, source: options.source ?? "typed" },
    });
    await inviteIfMatched(tx, access, profile.id, phone);
    return { ok: true, studentProfileId: profile.id };
  }, WRITE_TRANSACTION_OPTIONS);
}

/**
 * "Add from my other workspaces" (D-W39 item 2): a fresh profile here with the
 * name, phone and grade of one of the teacher's own profiles in another of
 * their workspaces. The source is re-resolved for this owner, so another
 * teacher's workspace or profile is not-found. No branch's students are read.
 */
export async function copyWorkspaceStudent(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  source: { workspaceId: string; studentProfileId: string },
  options: { now?: Date } = {},
): Promise<AddWorkspaceStudentResult> {
  if (source.workspaceId === workspaceId) return { ok: false, error: "notFound" };
  const from = await resolveWorkspaceAccess(db, actorUserId, source.workspaceId);
  if (!from) return { ok: false, error: "notFound" };
  const profile = await db.studentProfile.findFirst({
    where: scopedWhere(from.centerId, { id: source.studentProfileId }),
    select: { firstName: true, lastName: true, phone: true, gradeId: true },
  });
  if (!profile?.phone || !profile.firstName || !profile.lastName) return { ok: false, error: "notFound" };
  return addWorkspaceStudent(
    db,
    actorUserId,
    workspaceId,
    { firstName: profile.firstName, lastName: profile.lastName, phone: profile.phone, gradeId: profile.gradeId },
    { ...options, source: "copied" },
  );
}

// ── Invitations: the teacher's side ─────────────────────────────────────────

export type InviteAgainResult =
  | { ok: true }
  | { ok: false; error: WorkspaceAuthError | "rateLimited" | "inviteTooSoon" | "alreadyLinked" };

/**
 * "Invite again" (D-W39 item 6), on an unlinked profile at most once per
 * `INVITE_AGAIN_WINDOW_MS` — measured from the profile's last add or invite
 * audit row, the only thing stored about an attempt with no match. Cancels any
 * older PENDING invitation, then matches again. One answer either way.
 */
export async function inviteWorkspaceStudentAgain(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  studentProfileId: string,
  now: Date = new Date(),
): Promise<InviteAgainResult> {
  const gate = await authorizeWrite(db, actorUserId, workspaceId, STUDENTS, now);
  if (!gate.ok) return gate;
  if (!(await checkRateLimits([{ name: "workspaceInvitePerUser", key: actorUserId }]))) {
    return { ok: false, error: "rateLimited" };
  }
  return db.$transaction(async (tx): Promise<InviteAgainResult> => {
    const again = await regate(tx, actorUserId, workspaceId, now);
    if (!again.ok) return again;
    const access = again.access;
    const profile = await tx.studentProfile.findFirst({
      where: scopedWhere(access.centerId, { id: studentProfileId }),
      select: { id: true, phone: true, user: { select: { authId: true } } },
    });
    if (!profile) return { ok: false, error: "notFound" };
    if (profile.user.authId) return { ok: false, error: "alreadyLinked" };
    const last = await tx.auditLog.findFirst({
      where: {
        centerId: access.centerId,
        entityType: "StudentProfile",
        entityId: profile.id,
        action: { in: [WORKSPACE_STUDENT_AUDIT.add, WORKSPACE_STUDENT_AUDIT.invite] },
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (last && now.getTime() - last.createdAt.getTime() < INVITE_AGAIN_WINDOW_MS) {
      return { ok: false, error: "inviteTooSoon" };
    }
    await tx.workspaceInvitation.updateMany({
      where: scopedWhere(access.centerId, { studentProfileId: profile.id, status: PENDING }),
      data: { status: "CANCELLED", respondedAt: now },
    });
    await writeAuditRow(tx, {
      centerId: access.centerId,
      actorUserId,
      action: WORKSPACE_STUDENT_AUDIT.invite,
      entityType: "StudentProfile",
      entityId: profile.id,
    });
    await inviteIfMatched(tx, access, profile.id, profile.phone);
    return { ok: true };
  }, WRITE_TRANSACTION_OPTIONS);
}

export type CancelInvitationResult = { ok: true } | { ok: false; error: "notFound" | "forbidden" };

/**
 * The teacher withdraws whatever invitation is pending for a profile (D-W39
 * item 7). Offered on every unlinked profile and answered identically whether
 * or not one was pending, so it says nothing about a match. Reducing access,
 * so neither premium nor "not archived" is required.
 */
export async function cancelWorkspaceInvitation(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  studentProfileId: string,
  now: Date = new Date(),
): Promise<CancelInvitationResult> {
  return db.$transaction(async (tx): Promise<CancelInvitationResult> => {
    const access = await resolveWorkspaceAccess(tx, actorUserId, workspaceId);
    if (!access) return { ok: false, error: "notFound" };
    if (!workspaceCan({ workspace: access }, STUDENTS)) return { ok: false, error: "forbidden" };
    const profile = await tx.studentProfile.findFirst({
      where: scopedWhere(access.centerId, { id: studentProfileId }),
      select: { id: true },
    });
    if (!profile) return { ok: false, error: "notFound" };
    await tx.workspaceInvitation.updateMany({
      where: scopedWhere(access.centerId, { studentProfileId: profile.id, status: PENDING }),
      data: { status: "CANCELLED", respondedAt: now },
    });
    await writeAuditRow(tx, {
      centerId: access.centerId,
      actorUserId,
      action: WORKSPACE_STUDENT_AUDIT.cancel,
      entityType: "StudentProfile",
      entityId: profile.id,
    });
    return { ok: true };
  }, WRITE_TRANSACTION_OPTIONS);
}

// ── Invitations: the student's side ─────────────────────────────────────────

/** A PENDING invitation to `userId` from a live workspace, for a profile still unlinked. */
function pendingForUser(userId: string): Prisma.WorkspaceInvitationWhereInput {
  return {
    targetUserId: userId,
    status: PENDING,
    center: LIVE_WORKSPACE,
    studentProfile: { user: { authId: null } },
  };
}

/**
 * Whether the placeholder holds anything but the profile that just left it —
 * a stricter reading of "holds no other relation" than `deletePersonIfOrphaned`'s
 * own (which counts memberships and profiles), so a deletion can never cascade
 * a family link, a request or a claim away.
 */
async function placeholderHoldsNothingElse(tx: Tx, userId: string): Promise<boolean> {
  const row = await tx.user.findUnique({
    where: { id: userId },
    select: {
      authId: true,
      isPlatformAdmin: true,
      personalOrganization: { select: { id: true } },
      _count: {
        select: {
          memberships: true,
          studentProfiles: true,
          reservations: true,
          sessionBookings: true,
          familyLinksAsParent: true,
          familyLinksAsStudent: true,
          familyInvitations: true,
          accountClaims: true,
          sessionRatings: true,
          assistantsAsTeacher: true,
          assistantLinks: true,
          workspaceInvitations: true,
        },
      },
    },
  });
  if (!row || row.authId || row.isPlatformAdmin || row.personalOrganization) return false;
  return Object.values(row._count).every((count) => count === 0);
}

export type WorkspaceProfileMove = { moved: false } | { moved: true; placeholderRemoved: boolean };

/**
 * **The W8b move** (D-W39 item 7), on the caller's transaction — the one path
 * that attaches a workspace profile to an account, shared by accepting an
 * invitation and (W10, D-W43) redeeming a share code. The profile's `userId`
 * moves from its placeholder to the account **only if it still sits on that
 * placeholder** (a concurrent move finds nothing: `{ moved: false }`, and the
 * caller rolls back); its enrolments move with it and its local record is
 * untouched. Then any PENDING invitation to the account from this workspace
 * is cancelled (it now holds a profile here), and the placeholder is deleted
 * only when it holds nothing else.
 */
export async function moveWorkspaceProfileToAccount(
  tx: Tx,
  input: { centerId: string; studentProfileId: string; placeholderUserId: string; accountUserId: string; now: Date },
): Promise<WorkspaceProfileMove> {
  const moved = await tx.studentProfile.updateMany({
    where: scopedWhere(input.centerId, { id: input.studentProfileId, userId: input.placeholderUserId }),
    data: { userId: input.accountUserId },
  });
  if (moved.count !== 1) return { moved: false };
  await tx.workspaceInvitation.updateMany({
    where: scopedWhere(input.centerId, { targetUserId: input.accountUserId, status: PENDING }),
    data: { status: "CANCELLED", respondedAt: input.now },
  });
  const placeholderRemoved =
    (await placeholderHoldsNothingElse(tx, input.placeholderUserId)) &&
    (await deletePersonIfOrphaned(input.placeholderUserId, tx));
  return { moved: true, placeholderRemoved };
}

export type AcceptInvitationResult =
  | { ok: true; studentProfileId: string; placeholderRemoved: boolean }
  | { ok: false; error: "notFound" | "alreadyInWorkspace" };

/**
 * Confirm (D-W39 item 7). In one transaction: the invitation claimed
 * conditionally (two taps or two tabs accept once), the profile moved from its
 * placeholder to the account, any other PENDING invitation to this account
 * from the workspace cancelled (it now has a profile there), and the
 * placeholder removed only when it holds nothing else. Refused when the
 * account already has a profile in the workspace. Audited, ids only.
 */
export async function acceptWorkspaceInvitation(
  db: PrismaClient,
  actorUserId: string,
  invitationId: string,
  now: Date = new Date(),
): Promise<AcceptInvitationResult> {
  return db.$transaction(async (tx): Promise<AcceptInvitationResult> => {
    const invitation = await tx.workspaceInvitation.findFirst({
      where: { id: invitationId, ...pendingForUser(actorUserId) },
      select: { id: true, centerId: true, studentProfileId: true },
    });
    if (!invitation) return { ok: false, error: "notFound" };
    const profile = await tx.studentProfile.findFirst({
      where: scopedWhere(invitation.centerId, { id: invitation.studentProfileId }),
      select: { id: true, userId: true },
    });
    if (!profile) return { ok: false, error: "notFound" };
    const already = await tx.studentProfile.count({ where: scopedWhere(invitation.centerId, { userId: actorUserId }) });
    if (already > 0) return { ok: false, error: "alreadyInWorkspace" };

    const claimed = await tx.workspaceInvitation.updateMany({
      where: { id: invitation.id, status: PENDING },
      data: { status: "ACCEPTED", respondedAt: now },
    });
    if (claimed.count !== 1) return { ok: false, error: "notFound" };
    const move = await moveWorkspaceProfileToAccount(tx, {
      centerId: invitation.centerId,
      studentProfileId: profile.id,
      placeholderUserId: profile.userId,
      accountUserId: actorUserId,
      now,
    });
    if (!move.moved) throw new Error("workspace profile moved concurrently");
    const placeholderRemoved = move.placeholderRemoved;

    await writeAuditRow(tx, {
      centerId: invitation.centerId,
      actorUserId,
      action: WORKSPACE_STUDENT_AUDIT.accept,
      entityType: "WorkspaceInvitation",
      entityId: invitation.id,
      before: { status: PENDING },
      after: { status: "ACCEPTED", studentProfileId: profile.id, placeholderRemoved },
    });
    return { ok: true, studentProfileId: profile.id, placeholderRemoved };
  }, WRITE_TRANSACTION_OPTIONS);
}

export type DeclineInvitationResult = { ok: true } | { ok: false; error: "notFound" };

/** Cancel on the hub card (D-W39 item 7): DECLINED, and the profile stays unlinked. Audited, ids only. */
export async function declineWorkspaceInvitation(
  db: PrismaClient,
  actorUserId: string,
  invitationId: string,
  now: Date = new Date(),
): Promise<DeclineInvitationResult> {
  return db.$transaction(async (tx): Promise<DeclineInvitationResult> => {
    const invitation = await tx.workspaceInvitation.findFirst({
      where: { id: invitationId, ...pendingForUser(actorUserId) },
      select: { id: true, centerId: true },
    });
    if (!invitation) return { ok: false, error: "notFound" };
    const declined = await tx.workspaceInvitation.updateMany({
      where: { id: invitation.id, status: PENDING },
      data: { status: "DECLINED", respondedAt: now },
    });
    if (declined.count !== 1) return { ok: false, error: "notFound" };
    await writeAuditRow(tx, {
      centerId: invitation.centerId,
      actorUserId,
      action: WORKSPACE_STUDENT_AUDIT.decline,
      entityType: "WorkspaceInvitation",
      entityId: invitation.id,
      before: { status: PENDING },
      after: { status: "DECLINED" },
    });
    return { ok: true };
  }, WRITE_TRANSACTION_OPTIONS);
}

export type PendingWorkspaceInvitation = {
  id: string;
  workspaceName: string;
  teacherName: string | null;
  createdAt: Date;
};

/** The hub's invitation cards (D-W39 item 7): the workspace's name and its teacher's, nothing else. */
export async function pendingWorkspaceInvitations(db: Db, userId: string): Promise<PendingWorkspaceInvitation[]> {
  const rows = await db.workspaceInvitation.findMany({
    where: pendingForUser(userId),
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, centerId: true, createdAt: true, center: { select: { name: true } } },
  });
  const teachers = await workspaceTeacherNames(db, rows.map((row) => row.centerId));
  return rows.map((row) => ({
    id: row.id,
    workspaceName: row.center.name,
    teacherName: teachers.get(row.centerId) ?? null,
    createdAt: row.createdAt,
  }));
}

/** The workspaces with a PENDING invitation to `userId` — the invitation notice's re-check. */
export async function pendingInvitationCenterIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.workspaceInvitation.findMany({
    where: pendingForUser(userId),
    distinct: ["centerId"],
    select: { centerId: true },
  });
  return rows.map((row) => row.centerId);
}

// ── Enrolment ───────────────────────────────────────────────────────────────

export type WorkspaceEnrollResult =
  | { ok: true }
  | { ok: false; error: WorkspaceAuthError | "classInactive" | "studentInactive" | "alreadyEnrolled" };

/**
 * Enrols one of the workspace's own profiles in one of its classes (D-W39
 * item 11) through the shared seat function (`claimClassSeat` — it reactivates
 * a removed row rather than insert a second one). No approval and no seat cap:
 * the hidden room's capacity 0 means no limit.
 */
export async function enrolWorkspaceStudent(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  classGroupId: string,
  studentProfileId: string,
  now: Date = new Date(),
): Promise<WorkspaceEnrollResult> {
  const gate = await authorizeWrite(db, actorUserId, workspaceId, STUDENTS, now);
  if (!gate.ok) return gate;
  return db.$transaction(async (tx): Promise<WorkspaceEnrollResult> => {
    const again = await regate(tx, actorUserId, workspaceId, now);
    if (!again.ok) return again;
    const centerId = again.access.centerId;
    const [classGroup, profile] = await Promise.all([
      tx.classGroup.findFirst({ where: scopedWhere(centerId, { id: classGroupId }), select: { active: true } }),
      tx.studentProfile.findFirst({ where: scopedWhere(centerId, { id: studentProfileId }), select: { active: true } }),
    ]);
    if (!classGroup || !profile) return { ok: false, error: "notFound" };
    if (!classGroup.active) return { ok: false, error: "classInactive" };
    if (!profile.active) return { ok: false, error: "studentInactive" };
    const existing = await tx.enrollment.count({
      where: scopedWhere(centerId, { classGroupId, studentProfileId, status: { in: LIVE_ENROLLMENT_STATUSES } }),
    });
    if (existing > 0) return { ok: false, error: "alreadyEnrolled" };
    const seat = await claimClassSeat(tx, centerId, classGroupId, studentProfileId);
    // A capacity-0 room has no cap, so only a vanished row can refuse here.
    if (!seat.ok) return { ok: false, error: "notFound" };
    return { ok: true };
  }, WRITE_TRANSACTION_OPTIONS);
}

export type WorkspaceRemoveEnrollmentResult = { ok: true } | { ok: false; error: WorkspaceAuthError };

/** Removes a student from a workspace class — the staff removal's own effect (REMOVED, `leftByStudentAt` untouched). */
export async function removeWorkspaceEnrollment(
  db: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  enrollmentId: string,
  now: Date = new Date(),
): Promise<WorkspaceRemoveEnrollmentResult> {
  const gate = await authorizeWrite(db, actorUserId, workspaceId, STUDENTS, now);
  if (!gate.ok) return gate;
  return db.$transaction(async (tx): Promise<WorkspaceRemoveEnrollmentResult> => {
    const again = await regate(tx, actorUserId, workspaceId, now);
    if (!again.ok) return again;
    const removed = await tx.enrollment.updateMany({
      where: scopedWhere(again.access.centerId, { id: enrollmentId, status: { in: LIVE_ENROLLMENT_STATUSES } }),
      data: { status: "REMOVED" },
    });
    return removed.count === 1 ? { ok: true } : { ok: false, error: "notFound" };
  }, WRITE_TRANSACTION_OPTIONS);
}

// ── The teacher's reads (scoped by the workspace's centerId) ────────────────

const GRADE_NAME = { select: { nameAr: true, nameEn: true } } as const;

/**
 * One workspace student as the teacher sees them: the workspace's own local
 * record, and `linked` — a boolean, the one thing said about the account
 * (D-W39 item 4). No user id, account name, email or invitation state leaves.
 */
export type WorkspaceStudentRow = {
  id: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  gradeId: string | null;
  grade: { nameAr: string; nameEn: string } | null;
  active: boolean;
  linked: boolean;
  activeClasses: number;
};

function toStudentRow(row: {
  id: string;
  studentCode: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  gradeId: string | null;
  grade: { nameAr: string; nameEn: string } | null;
  active: boolean;
  user: { authId: string | null };
  _count: { enrollments: number };
}): WorkspaceStudentRow {
  return {
    id: row.id,
    studentCode: row.studentCode,
    firstName: row.firstName ?? "",
    lastName: row.lastName ?? "",
    phone: row.phone,
    gradeId: row.gradeId,
    grade: row.grade,
    active: row.active,
    linked: row.user.authId !== null,
    activeClasses: row._count.enrollments,
  };
}

const STUDENT_ROW_SELECT = {
  id: true,
  studentCode: true,
  firstName: true,
  lastName: true,
  phone: true,
  gradeId: true,
  grade: GRADE_NAME,
  active: true,
  // Only whether a login exists — never the account's name, email or id.
  user: { select: { authId: true } },
  _count: { select: { enrollments: { where: { status: ACTIVE_ENROLLMENT, classGroup: { active: true } } } } },
} satisfies Prisma.StudentProfileSelect;

/** The workspace's students, by name. */
export async function listWorkspaceStudents(db: Db, centerId: string): Promise<WorkspaceStudentRow[]> {
  const rows = await db.studentProfile.findMany({
    where: scopedWhere(centerId, {}),
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { createdAt: "asc" }],
    take: 1000,
    select: STUDENT_ROW_SELECT,
  });
  return rows.map(toStudentRow);
}

export type WorkspaceRosterRow = { enrollmentId: string; student: WorkspaceStudentRow };

/** A workspace class's ACTIVE roster, and the workspace's active profiles not on it (the enrol picker). */
export async function workspaceClassRoster(db: Db, centerId: string, classGroupId: string) {
  const [enrollments, students] = await Promise.all([
    db.enrollment.findMany({
      where: scopedWhere(centerId, { classGroupId, status: ACTIVE_ENROLLMENT }),
      orderBy: { enrolledAt: "asc" },
      select: { id: true, studentProfile: { select: STUDENT_ROW_SELECT } },
    }),
    db.studentProfile.findMany({
      where: scopedWhere(centerId, {
        active: true,
        enrollments: { none: { classGroupId, status: { in: LIVE_ENROLLMENT_STATUSES } } },
      }),
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      take: 1000,
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);
  return {
    roster: enrollments.map((row): WorkspaceRosterRow => ({ enrollmentId: row.id, student: toStudentRow(row.studentProfile) })),
    enrollable: students.map((row) => ({ id: row.id, firstName: row.firstName ?? "", lastName: row.lastName ?? "" })),
  };
}

export type CopyableStudentGroup = {
  workspaceId: string;
  workspaceName: string;
  students: { id: string; firstName: string; lastName: string; phone: string }[];
};

/**
 * The "Add from my other workspaces" picker (D-W39 item 2): the teacher's own
 * profiles in each of their other workspaces — one scoped read per workspace,
 * unioned in memory (rule 1) — less any whose phone is already here.
 */
export async function copyableWorkspaceStudents(
  db: Db,
  actorUserId: string,
  workspaceId: string,
): Promise<CopyableStudentGroup[]> {
  const access = await resolveWorkspaceAccess(db, actorUserId, workspaceId);
  if (!access) return [];
  const [others, herePhones] = await Promise.all([
    db.center.findMany({
      where: { ...ownedWorkspaceWhere(actorUserId), id: { not: access.centerId } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.studentProfile.findMany({ where: scopedWhere(access.centerId, { phone: { not: null } }), select: { phone: true } }),
  ]);
  const taken = new Set(herePhones.map((row) => row.phone));
  const groups = await Promise.all(
    others.map(async (workspace) => {
      const rows = await db.studentProfile.findMany({
        where: scopedWhere(workspace.id, { active: true, phone: { not: null } }),
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        take: 500,
        select: { id: true, firstName: true, lastName: true, phone: true },
      });
      return {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        students: rows
          .filter((row) => row.phone && !taken.has(row.phone))
          .map((row) => ({ id: row.id, firstName: row.firstName ?? "", lastName: row.lastName ?? "", phone: row.phone as string })),
      };
    }),
  );
  return groups.filter((group) => group.students.length > 0);
}

// ── The student's reads ─────────────────────────────────────────────────────

/**
 * The student-side resolver's input (D-W39 item 8): this account's **own**
 * active profiles at live PERSONAL workspaces — archived ones included, so
 * archiving never hides history. A profile still on its placeholder belongs
 * to the placeholder, so an unlinked profile reaches nobody.
 */
export function studentWorkspaceProfiles(db: Db, userId: string) {
  return db.studentProfile.findMany({
    where: { userId, active: true, center: LIVE_WORKSPACE },
    include: { center: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Whether the account has the Student experience through a workspace (D-W39 item 9). */
export async function hasWorkspaceStudentProfile(db: Db, userId: string): Promise<boolean> {
  return (await db.studentProfile.count({ where: { userId, active: true, center: LIVE_WORKSPACE } })) > 0;
}
