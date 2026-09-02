"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";

import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import {
  createCenterWithSettings,
  setCenterActive,
  updateCenterPlan,
} from "@/lib/db/platform";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  centerActiveSchema,
  centerPlanSchema,
  createCenterSchema,
} from "@/lib/validation/admin";

/**
 * The admin panel's write path (M9, docs/00-master-product-spec.md §4.4).
 * Every action: `requirePlatformAdmin()` → zod → the real `lib/db/platform.ts`
 * function → `AuditLog` (tenant creation/activation/plan changes are
 * sensitive — CLAUDE.md rule 7) → `revalidatePath` (docs/02 §7).
 *
 * `requirePlatformAdmin()` redirects (never returns) for anyone whose
 * `User.isPlatformAdmin` is false, so a non-admin — including an OWNER of
 * some other center — cannot reach any of these actions at all, the same
 * shape every other route-group gate in this app already relies on.
 */

export type AdminActionState = {
  /** Message key under `AdminCenters.errors`. */
  error?: string;
  fieldErrors?: Record<string, string>;
  status?: "created" | "saved";
  /** Set on a successful create — the founding owner's invite link. */
  invitationToken?: string;
};

export const IDLE_ADMIN_ACTION_STATE: AdminActionState = {};

const INVITE_TTL_DAYS = 7;

function centersPath(locale: string) {
  return `/${locale}${ROUTES.adminCenters}`;
}

function centerPath(locale: string, id: string) {
  return `/${locale}${ROUTES.adminCenter(id)}`;
}

export async function createCenterAction(
  _prevState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = createCenterSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, ownerEmail, ...input } = parsed.data;

  const invite = {
    email: ownerEmail,
    token: randomBytes(32).toString("base64url"),
    invitedBy: admin.id,
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
  };

  const result = await createCenterWithSettings(prisma, { ...input, invite });
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: result.center.id,
    actorUserId: admin.id,
    action: "platform.center.create",
    entityType: "Center",
    entityId: result.center.id,
    after: {
      name: result.center.name,
      slug: result.center.slug,
      plan: result.center.plan,
    },
  });

  revalidatePath(centersPath(locale));
  return { status: "created", invitationToken: invite.token };
}

export async function setCenterActiveAction(
  _prevState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = centerActiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id, active } = parsed.data;

  const before = await prisma.center.findUnique({ where: { id } });
  if (!before) return { error: "notFound" };

  await setCenterActive(prisma, id, active);

  await writeAuditLog({
    centerId: id,
    actorUserId: admin.id,
    action: active ? "platform.center.activate" : "platform.center.suspend",
    entityType: "Center",
    entityId: id,
    before: { active: before.active },
    after: { active },
  });

  revalidatePath(centersPath(locale));
  revalidatePath(centerPath(locale, id));
  return { status: "saved" };
}

export async function updateCenterPlanAction(
  _prevState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = centerPlanSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, id, plan } = parsed.data;

  const before = await prisma.center.findUnique({ where: { id } });
  if (!before) return { error: "notFound" };

  await updateCenterPlan(prisma, id, plan);

  await writeAuditLog({
    centerId: id,
    actorUserId: admin.id,
    action: "platform.center.plan.update",
    entityType: "Center",
    entityId: id,
    before: { plan: before.plan },
    after: { plan },
  });

  revalidatePath(centerPath(locale, id));
  return { status: "saved" };
}
