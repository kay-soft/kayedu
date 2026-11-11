import type { Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:assistants` and the data
// modules that re-check an assistant inside their own transaction
// (lib/db/assessments.ts, lib/db/assessment-results.ts, lib/db/assistant-requests.ts,
// lib/db/workspace-attendance.ts) call this outside the Next.js runtime.
import { isAssistantPermission, type AssistantPermission } from "../assistant-catalog.ts";
import { can, type Permission, type PermissionGrants } from "../auth/permissions.ts";
import { findEffectiveAssistantLink, type EffectiveAssistantLink } from "./assistants.ts";
import { ACCESSIBLE_CENTER } from "./platform.ts";
import { centreTimeZone } from "../scheduling.ts";
import {
  DEFAULT_CENTER_VISIBILITY_DAYS,
  DEFAULT_TEACHER_VISIBILITY_DAYS,
  assistantReadFloor,
  teacherHistoryFloor,
  type VisibilitySettings,
} from "./visibility.ts";
import { ownedWorkspaceWhere, workspaceCan, type WorkspaceAccess, type WorkspaceCapability } from "./workspaces.ts";

/**
 * Acting on behalf (W7b — D-W17, D-W18, D-W19, D-W37; docs/02 §18). The one
 * resolution of "what may this assistant do for this teacher, where", read
 * fresh on every call:
 *
 * - **The link** must be effective now (live, the teacher premium —
 *   `findEffectiveAssistantLink`, D-W15). Both ids come from the server: the
 *   session's user and the route's teacher. A posted link id, teacher id or
 *   centre id is never an input.
 * - **The branches** are the teacher's own: an ACTIVE TEACHER membership at an
 *   accessible branch — the teacher's relations, never the assistant's — whose
 *   `CenterSettings.allowTeacherAssistants` is on. A branch with it off is
 *   **absent** from the result, so nothing downstream can read or act there.
 * - **The workspaces (W8d, D-W41 items 9, 12)** are a second source, built the
 *   same way — only from the teacher's id, as the PERSONAL workspaces the
 *   teacher owns (`ownedWorkspaceWhere(teacherUserId)`), each with the
 *   teacher's ACTIVE TEACHER membership there. Archived ones are included
 *   (read-only); a workspace has no "allow assistants" switch.
 * - **The decision** is `assistantCan(acting, permission, centerId)`, the only
 *   place it is made. At a branch: the assistant's grant **and** the teacher's
 *   own centre authority for the equivalent teacher action there (the stored
 *   TEACHER cell, and the trusted flag for requests) **and** the branch
 *   present (the setting on). In a workspace: the assistant's grant **and** the
 *   teacher's own fixed workspace capability (`workspaceCan` on the teacher's
 *   access); every write also runs `assertWorkspaceWritable` (premium, not
 *   archived) in the data layer. Deny by default.
 *
 * An assistant gets no Membership, no PermissionGrant row, no TenantContext of
 * their own and no centre role here: `ASSISTANT` is not a `TenantRole`, and
 * this module only ever reads (rule 6, W-C3).
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type AssistantActingBranch = {
  centerId: string;
  centerName: string;
  /** The teacher's ACTIVE TEACHER membership at this branch. */
  teacherMembershipId: string;
  isTrustedTeacher: boolean;
  /** The branch's stored TEACHER cells — the teacher's own centre authority here. */
  teacherGrants: PermissionGrants;
  settings: VisibilitySettings;
};

/** One of the teacher's PERSONAL workspaces, as the assistant may reach it (W8d). */
export type AssistantActingWorkspace = {
  centerId: string;
  centerName: string;
  /** The teacher's ACTIVE TEACHER membership in the workspace, or null (then nothing is allowed). */
  teacherMembershipId: string | null;
  archivedAt: Date | null;
  timezone: string;
};

export type AssistantActing = {
  actorUserId: string;
  teacherUserId: string;
  linkId: string;
  /** The effective link itself (the teacher's name, the preset) — read here, once. */
  link: EffectiveAssistantLink;
  /** The link's grants, catalogue names only. */
  grants: AssistantPermission[];
  teacherHistoryDays: number;
  /** The teacher's branches that allow assistants — only these exist for the assistant. */
  branches: AssistantActingBranch[];
  /** W8d: the teacher's own PERSONAL workspaces (archived ones included — read-only). */
  workspaces: AssistantActingWorkspace[];
};

/**
 * The teacher action each catalogue key stands for at a branch (D-W17: an
 * assistant's action is the teacher's action there). `null` = no teacher cell
 * beyond the ACTIVE TEACHER membership itself (the teacher's ungated Sessions
 * and class pages). `false` = nothing at a branch: the workspace keys act only
 * in PERSONAL workspaces (`WORKSPACE_EQUIVALENT`), and `students.phones`
 * reveals nothing at a branch because the teacher's own portal shows no
 * student phone (D-W37).
 */
const TEACHER_EQUIVALENT: Readonly<Record<AssistantPermission, Permission | null | false>> = {
  "assessments.review": "assessment.manage.own",
  "assessments.manage": "assessment.manage.own",
  "classes.view": null,
  "requests.manage": "changeRequest.create",
  "checkin.workspace": false,
  "payments.workspace": false,
  "analytics.view": "analytics.own.view",
  "students.phones": false,
};

/**
 * What each catalogue key stands for in the teacher's PERSONAL workspace
 * (W8d, D-W41 item 9): the teacher's fixed workspace capability, or `null` =
 * owning the workspace with its TEACHER membership alone (the read-only
 * workspace pages, the Earnings page and the rosters' phones), or `false` =
 * nothing there. Assessments in workspaces are W9; requests have no workspace
 * meaning (the teacher files none to themselves).
 */
const WORKSPACE_EQUIVALENT: Readonly<Record<AssistantPermission, WorkspaceCapability | null | false>> = {
  "assessments.review": false,
  "assessments.manage": false,
  "classes.view": null,
  "requests.manage": false,
  "checkin.workspace": "workspace.attendance.manage",
  "payments.workspace": "workspace.payments.manage",
  "analytics.view": null,
  "students.phones": null,
};

/** The teacher's own access to their workspace, for `workspaceCan` — built from the resolved source only. */
function teacherWorkspaceAccess(teacherUserId: string, workspace: AssistantActingWorkspace): WorkspaceAccess {
  return {
    actorUserId: teacherUserId,
    ownerUserId: teacherUserId,
    centerId: workspace.centerId,
    kind: "PERSONAL",
    archivedAt: workspace.archivedAt,
    membershipId: workspace.teacherMembershipId,
  };
}

/** The grants that satisfy a key: itself, and Manage also covers Review (D-W37). */
function heldGrant(grants: readonly AssistantPermission[], permission: AssistantPermission): boolean {
  if (grants.includes(permission)) return true;
  return permission === "assessments.review" && grants.includes("assessments.manage");
}

/**
 * **The only place** an assistant's permission is decided (D-W37 item 2,
 * D-W41 item 9): effective = (the assistant's grant) AND (the teacher's own
 * authority for the equivalent teacher action there — at a branch the stored
 * TEACHER cell, including the trusted flag where the teacher needs it; in a
 * workspace the teacher's fixed capability) AND (at a branch, the branch
 * allows assistants). Pure: `acting` comes from `resolveAssistantActing`, read
 * fresh per request (or per transaction, `assistantMayAt`).
 */
export function assistantCan(
  acting:
    | (Pick<AssistantActing, "grants" | "branches"> & Partial<Pick<AssistantActing, "workspaces" | "teacherUserId">>)
    | null
    | undefined,
  permission: AssistantPermission,
  centerId: string | null | undefined,
): boolean {
  if (!acting || !centerId || !isAssistantPermission(permission)) return false;
  if (!heldGrant(acting.grants, permission)) return false;
  // W8d: one of the teacher's workspaces — the teacher's own fixed capability there.
  const workspace = acting.workspaces?.find((entry) => entry.centerId === centerId);
  if (workspace) {
    if (!acting.teacherUserId) return false;
    const capability = WORKSPACE_EQUIVALENT[permission];
    if (capability === false) return false;
    const access = teacherWorkspaceAccess(acting.teacherUserId, workspace);
    // A read (`null`) is owning the workspace with its TEACHER membership —
    // which any one of the teacher's capabilities requires; a write, its own one.
    return workspaceCan({ workspace: access }, capability ?? "workspace.sessions.manage");
  }
  const branch = acting.branches.find((entry) => entry.centerId === centerId);
  if (!branch) return false;
  const equivalent = TEACHER_EQUIVALENT[permission];
  if (equivalent === false) return false;
  if (equivalent !== null && !can("TEACHER", equivalent, branch.teacherGrants)) return false;
  if (permission === "requests.manage" && !branch.isTrustedTeacher) return false;
  return true;
}

/** The branches where `assistantCan` grants `permission` — what a page lists. */
export function assistantBranchesFor(acting: AssistantActing, permission: AssistantPermission): AssistantActingBranch[] {
  return acting.branches.filter((branch) => assistantCan(acting, permission, branch.centerId));
}

/** The workspaces where `assistantCan` grants `permission` (W8d). */
export function assistantWorkspacesFor(
  acting: Pick<AssistantActing, "grants" | "branches" | "workspaces" | "teacherUserId">,
  permission: AssistantPermission,
): AssistantActingWorkspace[] {
  return acting.workspaces.filter((workspace) => assistantCan(acting, permission, workspace.centerId));
}

/** The keys that open the assistant's Workspaces pages (W8d): reading classes, or acting on sessions. */
export const ASSISTANT_WORKSPACE_KEYS: readonly AssistantPermission[] = ["classes.view", "checkin.workspace", "payments.workspace"];

/** The workspaces the assistant may open at all — one of `ASSISTANT_WORKSPACE_KEYS` granted there. */
export function assistantOpenWorkspaces(
  acting: Pick<AssistantActing, "grants" | "branches" | "workspaces" | "teacherUserId">,
): AssistantActingWorkspace[] {
  return acting.workspaces.filter((workspace) => ASSISTANT_WORKSPACE_KEYS.some((key) => assistantCan(acting, key, workspace.centerId)));
}

/** The assistant's read floor at one branch: the stricter of the branch's teacher window and the teacher's own (D-W19). */
export function assistantFloorAt(acting: Pick<AssistantActing, "teacherHistoryDays">, branch: Pick<AssistantActingBranch, "settings">, now: Date = new Date()): Date {
  return assistantReadFloor({ settings: branch.settings, teacherHistoryDays: acting.teacherHistoryDays }, now);
}

/** The assistant's read floor in a workspace (D-W19, D-W41 item 5): the teacher's `teacherHistoryDays` only, or null. */
export function assistantWorkspaceFloor(
  acting: Pick<AssistantActing, "teacherHistoryDays">,
  workspace: Pick<AssistantActingWorkspace, "timezone">,
  now: Date = new Date(),
): Date | null {
  return teacherHistoryFloor(acting.teacherHistoryDays, workspace.timezone, now);
}

/**
 * Resolves what the assistant may do for the teacher, or `null` (no effective
 * link: none, removed, left, the teacher not premium now, or someone else's
 * teacher id). Every call reads the database again — a revoked grant, a
 * switched-off cell, a lapsed premium, an archived workspace or a branch
 * setting turned off takes effect on the next request with nothing to
 * invalidate.
 */
export async function resolveAssistantActing(
  db: Db,
  input: { assistantUserId: string | null | undefined; teacherUserId: string | null | undefined; now?: Date },
): Promise<AssistantActing | null> {
  const { assistantUserId, teacherUserId } = input;
  if (!assistantUserId || !teacherUserId || assistantUserId === teacherUserId) return null;
  const now = input.now ?? new Date();
  const link = await findEffectiveAssistantLink(db, { assistantUserId, teacherUserId, now });
  if (!link) return null;

  const [teacher, memberships, workspaces] = await Promise.all([
    db.user.findUnique({ where: { id: teacherUserId }, select: { teacherHistoryDays: true } }),
    db.membership.findMany({
      where: { userId: teacherUserId, role: "TEACHER", active: true, center: ACCESSIBLE_CENTER },
      select: {
        id: true,
        isTrustedTeacher: true,
        center: {
          select: {
            id: true,
            name: true,
            settings: {
              select: {
                allowTeacherAssistants: true,
                centerDataVisibilityDays: true,
                teacherDataVisibilityDays: true,
                timezone: true,
              },
            },
          },
        },
      },
      orderBy: [{ center: { name: "asc" } }, { id: "asc" }],
    }),
    // W8d (D-W41 item 9): the teacher's own workspaces — from the teacher's id only.
    db.center.findMany({
      where: ownedWorkspaceWhere(teacherUserId),
      select: {
        id: true,
        name: true,
        archivedAt: true,
        settings: { select: { timezone: true } },
        memberships: { where: { userId: teacherUserId, role: "TEACHER", active: true }, select: { id: true }, take: 1 },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
  ]);
  if (!teacher) return null;

  // Default ON (D-W19): a branch without a settings row yet allows assistants.
  const allowed = memberships.filter((membership) => membership.center.settings?.allowTeacherAssistants ?? true);
  const cells = await Promise.all(
    allowed.map((membership) =>
      db.permissionGrant.findMany({
        where: { centerId: membership.center.id, role: "TEACHER" },
        select: { action: true, allowed: true },
      }),
    ),
  );

  return {
    actorUserId: assistantUserId,
    teacherUserId,
    linkId: link.linkId,
    link,
    grants: link.permissions,
    teacherHistoryDays: teacher.teacherHistoryDays,
    branches: allowed.map((membership, index) => {
      const teacherGrants: PermissionGrants = {};
      for (const cell of cells[index]) teacherGrants[cell.action as Permission] = cell.allowed;
      const settings = membership.center.settings;
      return {
        centerId: membership.center.id,
        centerName: membership.center.name,
        teacherMembershipId: membership.id,
        isTrustedTeacher: membership.isTrustedTeacher,
        teacherGrants,
        settings: {
          centerDataVisibilityDays: settings?.centerDataVisibilityDays ?? DEFAULT_CENTER_VISIBILITY_DAYS,
          teacherDataVisibilityDays: settings?.teacherDataVisibilityDays ?? DEFAULT_TEACHER_VISIBILITY_DAYS,
          timezone: centreTimeZone(settings),
        },
      };
    }),
    workspaces: workspaces.map((workspace) => ({
      centerId: workspace.id,
      centerName: workspace.name,
      teacherMembershipId: workspace.memberships[0]?.id ?? null,
      archivedAt: workspace.archivedAt,
      timezone: centreTimeZone(workspace.settings),
    })),
  };
}

/**
 * The data layer's own re-check (D-W37 item 2, rule 6): resolved again on the
 * caller's client — inside a write's transaction — and decided by
 * `assistantCan`. A writer that is handed an actor other than the owning
 * teacher calls this, so a direct call can never let an assistant pass a
 * check the teacher would fail.
 */
export async function assistantMayAt(
  db: Db,
  input: { assistantUserId: string; teacherUserId: string; centerId: string; permission: AssistantPermission; now?: Date },
): Promise<boolean> {
  const acting = await resolveAssistantActing(db, input);
  return assistantCan(acting, input.permission, input.centerId);
}

/** The audit row's `onBehalfOfUserId` for a write by `actorUserId` as `teacherUserId` (D-W18): null for the teacher's own. */
export function onBehalfOf(actorUserId: string, teacherUserId: string): string | null {
  return actorUserId === teacherUserId ? null : teacherUserId;
}
