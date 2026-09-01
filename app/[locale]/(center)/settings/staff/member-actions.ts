"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@prisma/client";

import { ctxCan, getTenantContext, type TenantContext } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { scoped, type ScopedDb } from "@/lib/db/scoped";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom, type ActionState } from "@/lib/validation/form";
import {
  memberActiveSchema,
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

export async function changeMemberRoleAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const scope = await staffScope();
  if (!scope) return FORBIDDEN;

  const parsed = memberRoleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { membershipId, role, locale } = parsed.data;

  // Scoped lookup: an id from another center never resolves.
  const membership = await scope.db.memberships.findById(membershipId);
  if (!membership) return NOT_FOUND;
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
  if (membership.active === active) return { status: "saved" };
  if (membership.userId === scope.ctx.user.id) return { error: "selfEdit" };

  const guard = await ownerGuard(scope, membership, membership.role, active);
  if (guard) return guard;

  await scope.db.memberships.update(membership.id, {
    active,
    // Re-activating someone who never accepted still counts as joining now.
    ...(active && !membership.joinedAt ? { joinedAt: new Date() } : {}),
  });

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
