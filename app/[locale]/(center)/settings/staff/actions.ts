"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";

import { writeAuditLog } from "@/lib/db/audit";
import { scoped } from "@/lib/db/scoped";
import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { fieldErrorsFrom } from "@/lib/validation/form";
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
  const ctx = await getTenantContext({ experience: "center" });
  if (!ctxCan(ctx, "staff.invite")) return { error: "forbidden" };

  const parsed = createInvitationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const { email, role, locale } = parsed.data;
  const db = scoped(ctx);

  // Only an Owner may mint another Owner.
  if (role === "OWNER" && !ctxCan(ctx, "center.ownership.manage")) {
    return { error: "ownerOnly" };
  }

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
    centerId: ctx.center.id,
    actorUserId: ctx.user.id,
    action: "invitation.create",
    entityType: "Invitation",
    entityId: invitation.id,
    after: { email, role, expiresAt: expiresAt.toISOString() },
  });

  revalidatePath(staffPath(locale));
  return { token };
}

export async function revokeInvitationAction(
  formData: FormData,
): Promise<void> {
  const ctx = await getTenantContext({ experience: "center" });
  if (!ctxCan(ctx, "staff.invite")) return;

  const parsed = invitationIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return;

  const db = scoped(ctx);
  // Scoped lookup: an id from another center simply does not resolve.
  const invitation = await db.invitations.findById(parsed.data.invitationId);
  if (!invitation || invitation.status !== "PENDING") return;

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
}
