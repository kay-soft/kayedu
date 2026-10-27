"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";

import { writeAuditLog } from "@/lib/db/audit";
import { scoped } from "@/lib/db/scoped";
import { PICK_BRANCH, requireBranchScope } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext, getTenantContextForBranch } from "@/lib/auth/tenant";
import { fieldErrorsFrom, type ActionState } from "@/lib/validation/form";
import {
  createInvitationSchema,
  invitationIdSchema,
} from "@/lib/validation/auth";
import { ROUTES } from "@/lib/routes";

export type InviteFormState = {
  /** Message key under `Staff.errors`. */
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Set on success — the accept link is shown for manual delivery. */
  token?: string;
  /** F1: set when the invitation is for a branch other than the active one. */
  branchName?: string;
};

const INVITE_TTL_DAYS = 7;

function staffPath(locale: string) {
  return `/${locale}${ROUTES.centerStaff}`;
}

/**
 * Every action: getTenantContext() → permission check → zod → scoped write →
 * audit (permission change) → revalidate. (docs/02 §7)
 *
 * Email delivery is out of Phase 1 scope (notifications are deferred), so the
 * accept link is returned for the inviter to share.
 */
export async function createInvitationAction(
  _prevState: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return PICK_BRANCH;
  // Inviting someone assigns them a role, so this is an OWNER-only action
  // (docs/00-master-product-spec.md §3: "the only role that may grant roles
  // or permissions") — `membership.role.assign` is ceiling-forced to OWNER
  // (lib/auth/permissions.ts), so this can never be satisfied by any stored
  // grant, only by actually being OWNER.
  if (!ctxCan(ctx, "membership.role.assign")) return { error: "forbidden" };

  const parsed = createInvitationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { email, role, locale, branchId } = parsed.data;

  // F1: an invitation may target another branch. The posted id is never
  // trusted — the actor's context is re-resolved at that branch through the
  // same relation resolution, the same permission is checked *there*, and
  // the write is scoped to that branch's centerId. D-22 is unchanged: only
  // an OWNER (at the target) can satisfy `membership.role.assign`.
  const target = branchId && branchId !== ctx.center.id
    ? await getTenantContextForBranch(branchId, "center")
    : ctx;
  if (!target) return { fieldErrors: { branchId: "invalidCenter" } };
  if (!ctxCan(target, "membership.role.assign")) return { error: "forbidden" };

  const db = scoped(target);

  const existingMember = await db.memberships.list({
    where: { role, active: true, user: { email } },
  });
  if (existingMember.length > 0) return { error: "alreadyMember" };

  // Supersede any outstanding invite for the same email + role.
  await db.invitations.updateMany(
    { email, role, status: "PENDING" },
    { status: "REVOKED" },
  );

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const invitation = await db.invitations.create({
    email,
    role,
    token,
    invitedBy: ctx.user.id,
    expiresAt,
  });

  await writeAuditLog({
    centerId: target.center.id,
    actorUserId: ctx.user.id,
    action: "invitation.create",
    entityType: "Invitation",
    entityId: invitation.id,
    // D-20: the invited address stays on the invitation row.
    after: { role, expiresAt: expiresAt.toISOString() },
  });

  revalidatePath(staffPath(locale));
  return {
    token,
    ...(target.center.id !== ctx.center.id ? { branchName: target.center.name } : {}),
  };
}

/**
 * Returns a result (DES, Phase 3) — it had returned nothing, so a refused
 * revoke looked exactly like a successful one. Error keys are `Settings.errors`.
 */
export async function revokeInvitationAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return PICK_BRANCH;
  // D-22 (a): revoking an invitation is OWNER-only, exactly like creating one
  // (SEC-42) — `membership.role.assign` is ceiling-forced to OWNER.
  if (!ctxCan(ctx, "membership.role.assign")) return { error: "forbidden" };

  const parsed = invitationIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };

  const db = scoped(ctx);
  // Scoped lookup: an id from another center simply does not resolve.
  const invitation = await db.invitations.findById(parsed.data.invitationId);
  if (!invitation) return { error: "notFound" };
  if (invitation.status !== "PENDING") return { error: "invitationGone" };

  await db.invitations.update(invitation.id, { status: "REVOKED" });

  await writeAuditLog({
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "invitation.revoke",
    entityType: "Invitation",
    entityId: invitation.id,
    before: { status: "PENDING" },
    after: { status: "REVOKED" },
  });

  revalidatePath(staffPath(parsed.data.locale));
  return { status: "deleted" };
}
