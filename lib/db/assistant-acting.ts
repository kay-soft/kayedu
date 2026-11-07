import type { Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:assistants` and the data
// modules that re-check an assistant inside their own transaction
// (lib/db/assessments.ts, lib/db/assessment-results.ts, lib/db/assistant-requests.ts)
// call this outside the Next.js runtime.
import { isAssistantPermission, type AssistantPermission } from "../assistant-catalog.ts";
import { can, type Permission, type PermissionGrants } from "../auth/permissions.ts";
import { findEffectiveAssistantLink } from "./assistants.ts";
import { ACCESSIBLE_CENTER } from "./platform.ts";
import { centreTimeZone } from "../scheduling.ts";
import {
  DEFAULT_CENTER_VISIBILITY_DAYS,
  DEFAULT_TEACHER_VISIBILITY_DAYS,
  assistantReadFloor,
  type VisibilitySettings,
} from "./visibility.ts";

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
 * - **The decision** is `assistantCan(acting, permission, centerId)`, the only
 *   place it is made: the assistant's grant **and** the teacher's own centre
 *   authority for the equivalent teacher action at that branch (the stored
 *   TEACHER cell, and the trusted flag for requests) **and** the branch
 *   present (the setting on). Deny by default.
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

export type AssistantActing = {
  actorUserId: string;
  teacherUserId: string;
  linkId: string;
  /** The link's grants, catalogue names only. */
  grants: AssistantPermission[];
  teacherHistoryDays: number;
  /** The teacher's branches that allow assistants — only these exist for the assistant. */
  branches: AssistantActingBranch[];
};

/**
 * The teacher action each catalogue key stands for at a branch (D-W17: an
 * assistant's action is the teacher's action there). `null` = no teacher cell
 * beyond the ACTIVE TEACHER membership itself (the teacher's ungated Sessions
 * and class pages). `false` = nothing at a branch in W7b: the workspace keys
 * act only in PERSONAL workspaces (W8), and `students.phones` reveals nothing
 * because the teacher's own portal shows no student phone (D-W37).
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

/** The grants that satisfy a key: itself, and Manage also covers Review (D-W37). */
function heldGrant(grants: readonly AssistantPermission[], permission: AssistantPermission): boolean {
  if (grants.includes(permission)) return true;
  return permission === "assessments.review" && grants.includes("assessments.manage");
}

/**
 * **The only place** an assistant's permission is decided (D-W37 item 2):
 * effective = (the assistant's grant) AND (the teacher's own authority for the
 * equivalent teacher action at that branch, including the trusted flag where
 * the teacher needs it) AND (the branch allows assistants). Pure: `acting`
 * comes from `resolveAssistantActing`, read fresh per request (or per
 * transaction, `assistantMayAt`).
 */
export function assistantCan(
  acting: Pick<AssistantActing, "grants" | "branches"> | null | undefined,
  permission: AssistantPermission,
  centerId: string | null | undefined,
): boolean {
  if (!acting || !centerId || !isAssistantPermission(permission)) return false;
  if (!heldGrant(acting.grants, permission)) return false;
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

/** The assistant's read floor at one branch: the stricter of the branch's teacher window and the teacher's own (D-W19). */
export function assistantFloorAt(acting: Pick<AssistantActing, "teacherHistoryDays">, branch: Pick<AssistantActingBranch, "settings">, now: Date = new Date()): Date {
  return assistantReadFloor({ settings: branch.settings, teacherHistoryDays: acting.teacherHistoryDays }, now);
}

/**
 * Resolves what the assistant may do for the teacher, or `null` (no effective
 * link: none, removed, left, the teacher not premium now, or someone else's
 * teacher id). Every call reads the database again — a revoked grant, a
 * switched-off cell, a lapsed premium or a branch setting turned off takes
 * effect on the next request with nothing to invalidate.
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

  const [teacher, memberships] = await Promise.all([
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
