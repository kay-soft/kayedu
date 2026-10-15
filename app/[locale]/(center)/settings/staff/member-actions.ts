"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { isBranchGrantableRole } from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { organizationBranches } from "@/lib/db/organizations";
import { scopedWhere } from "@/lib/db/tenant-scope";
import { grantMembershipBranch, revokeMembershipBranch } from "@/lib/db/permissions";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom, type ActionState } from "@/lib/validation/form";
import {
  memberActiveSchema,
  membershipBranchGrantSchema,
  memberRoleSchema,
} from "@/lib/validation/settings";

/**
 * Users & roles — changing an existing membership (M2). Creating one is the
 * invite flow in ./actions.ts.
 *
 * Every change here is a **permission change**, so every one of them writes an
 * AuditLog row (CLAUDE.md rule 7).
 */

const FORBIDDEN: ActionState = { error: "forbidden" };
const NOT_FOUND: ActionState = { error: "notFound" };
/**
 * Teachers are managed on the Teachers page, never here (R9) — refused by
 * direct call whether the TEACHER role is the one being assigned or the one
 * being edited.
 */
const TEACHER_ELSEWHERE: ActionState = { error: "teacherViaTeachersPage" };

function staffPath(locale: string): string {
  return `/${locale}${ROUTES.centerStaff}`;
}

async function staffScope(): Promise<{ ctx: TenantContext; db: ScopedDb } | null> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "staff.manage")) return null;
  return { ctx, db: scoped(ctx) };
}

/**
 * A center must never be left without an owner, and only an owner may create,
 * demote or deactivate another owner (docs/02 §3).
 */
async function ownerGuard(
  scope: { ctx: TenantContext; db: ScopedDb },
  membership: { id: string; role: Role; active: boolean },
  nextRole: Role,
  nextActive: boolean,
): Promise<ActionState | null> {
  const touchesOwner = membership.role === "OWNER" || nextRole === "OWNER";
  if (touchesOwner && !ctxCan(scope.ctx, "center.ownership.manage")) {
    return { error: "ownerOnly" };
  }

  const losesOwner =
    membership.role === "OWNER" &&
    membership.active &&
    (nextRole !== "OWNER" || !nextActive);

  if (losesOwner) {
    const owners = await scope.db.memberships.count({
      role: "OWNER",
      active: true,
    });
    if (owners <= 1) return { error: "lastOwner" };
  }

  return null;
}

/**
 * An OWNER who stops being one takes their unaccepted invitations with them
 * (SEC-42): a departing owner must not leave a week-long OWNER invitation
 * behind. Revoked branch by branch across the organisation an Owner reaches
 * — one `centerId`-scoped write per branch, never a cross-centre `where`.
 */
async function revokeInvitationsBy(
  ctx: TenantContext,
  inviterUserId: string,
): Promise<number> {
  const branches = await organizationBranches(prisma, ctx.center.organizationId);
  const branchIds = new Set([ctx.center.id, ...branches.map((branch) => branch.id)]);
  let revoked = 0;
  for (const branchId of branchIds) {
    const { count } = await prisma.invitation.updateMany({
      where: scopedWhere(branchId, { invitedBy: inviterUserId, status: "PENDING" as const }),
      data: { status: "REVOKED" },
    });
    revoked += count;
  }
  if (revoked > 0) {
    await writeAuditLog({
      centerId: ctx.center.id,
      actorUserId: ctx.user.id,
      action: "invitation.revoke",
      entityType: "User",
      entityId: inviterUserId,
      after: { trigger: "inviterLostOwner", count: revoked },
    });
  }
  return revoked;
}

export async function changeMemberRoleAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await staffScope();
  if (!scope) return FORBIDDEN;
  // Changing a role is granting a role (docs/00-master-product-spec.md §3):
  // OWNER only, by UI and by direct call. `membership.role.assign` is
  // ceiling-forced to OWNER (lib/auth/permissions.ts), so `staff.manage`
  // alone (which a MANAGER also holds) is never enough here.
  if (!ctxCan(scope.ctx, "membership.role.assign")) return FORBIDDEN;

  const parsed = memberRoleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors = fieldErrorsFrom(parsed.error);
    // `role` is a closed list of staff roles (`staffRoleField`); naming the
    // TEACHER case gets its own message instead of a generic "not found".
    return fieldErrors.role === TEACHER_ELSEWHERE.error
      ? { ...TEACHER_ELSEWHERE, fieldErrors }
      : { fieldErrors };
  }

  const { membershipId, role, locale } = parsed.data;

  // Scoped lookup: an id from another center never resolves.
  const membership = await scope.db.memberships.findById(membershipId);
  if (!membership) return NOT_FOUND;
  if (membership.role === "TEACHER") return TEACHER_ELSEWHERE;
  if (membership.role === role) return { status: "saved" };

  // Nobody edits their own access — that is how a center locks itself out.
  if (membership.userId === scope.ctx.user.id) return { error: "selfEdit" };

  const guard = await ownerGuard(scope, membership, role, membership.active);
  if (guard) return guard;

  // Membership is unique on (userId, centerId, role), so moving this row onto
  // a role the person already holds here would collide.
  const existing = await scope.db.memberships.list({
    where: { userId: membership.userId, role },
  });
  if (existing.length > 0) return { error: "alreadyMember" };

  await scope.db.memberships.update(membership.id, { role });
  if (membership.role === "OWNER") await revokeInvitationsBy(scope.ctx, membership.userId);

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: "membership.role.change",
    entityType: "Membership",
    entityId: membership.id,
    before: { role: membership.role },
    after: { role },
  });

  revalidatePath(staffPath(locale));
  return { status: "saved" };
}

export async function setMemberActiveAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await staffScope();
  if (!scope) return FORBIDDEN;

  const parsed = memberActiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const { membershipId, active, locale } = parsed.data;

  const membership = await scope.db.memberships.findById(membershipId);
  if (!membership) return NOT_FOUND;
  if (membership.role === "TEACHER") return TEACHER_ELSEWHERE;
  if (membership.active === active) return { status: "saved" };
  if (membership.userId === scope.ctx.user.id) return { error: "selfEdit" };

  // D-09 (a), SEC-14: bringing a membership back re-grants its whole role, so
  // reactivating is OWNER-only (`membership.role.assign`). A MANAGER may still
  // deactivate — taking access away is not a grant.
  if (active && !ctxCan(scope.ctx, "membership.role.assign")) return FORBIDDEN;

  const guard = await ownerGuard(scope, membership, membership.role, active);
  if (guard) return guard;

  await scope.db.memberships.update(membership.id, {
    active,
    // Re-activating someone who never accepted still counts as joining now.
    ...(active && !membership.joinedAt ? { joinedAt: new Date() } : {}),
  });
  if (!active && membership.role === "OWNER") {
    await revokeInvitationsBy(scope.ctx, membership.userId);
  }

  await writeAuditLog({
    centerId: scope.ctx.center.id,
    actorUserId: scope.ctx.user.id,
    action: active ? "membership.activate" : "membership.deactivate",
    entityType: "Membership",
    entityId: membership.id,
    before: { active: membership.active },
    after: { active },
  });

  revalidatePath(staffPath(locale));
  return { status: "saved" };
}

/**
 * Widens a MANAGER/RECEPTIONIST/ACCOUNTANT membership's reach to one more
 * branch under this organization (M12, docs/01-data-model.md "Organization
 * layer") — OWNER only, by UI and by direct call: `membership.branch.grant`
 * is ceiling-forced to OWNER, so `staff.manage` alone is never enough.
 */
export async function grantMembershipBranchAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "membership.branch.grant")) return FORBIDDEN;

  const parsed = membershipBranchGrantSchema.safeParse(Object.fromEntries(formData));
  // The one input a person chooses is the branch; an empty choice is "pick one".
  if (!parsed.success) return { error: "invalidBranch" };
  const { membershipId, centerId: targetCenterId, locale } = parsed.data;

  const db = scoped(ctx);
  const membership = await db.memberships.findById(membershipId);
  if (!membership) return NOT_FOUND;
  if (!isBranchGrantableRole(membership.role)) return { error: "branchNotGrantable" };

  // The target must be a real sibling branch under this organization — never
  // trusted from the form beyond that.
  const siblings = await organizationBranches(prisma, ctx.center.organizationId);
  const target = siblings.find((branch) => branch.id === targetCenterId);
  if (!target || target.id === ctx.center.id) return { error: "invalidBranch" };

  await grantMembershipBranch(prisma, membership.id, target.id, ctx.user.id);

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "membership.branch.grant",
    entityType: "Membership",
    entityId: membership.id,
    after: { centerId: target.id },
  });

  revalidatePath(staffPath(locale));
  return { status: "saved" };
}

export async function revokeMembershipBranchAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await getTenantContext("center");
  if (!ctxCan(ctx, "membership.branch.grant")) return FORBIDDEN;

  const parsed = membershipBranchGrantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { membershipId, centerId: targetCenterId, locale } = parsed.data;

  const db = scoped(ctx);
  const membership = await db.memberships.findById(membershipId);
  if (!membership) return NOT_FOUND;

  await revokeMembershipBranch(prisma, membership.id, targetCenterId);

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "membership.branch.revoke",
    entityType: "Membership",
    entityId: membership.id,
    before: { centerId: targetCenterId },
  });

  revalidatePath(staffPath(locale));
  return { status: "deleted" };
}
