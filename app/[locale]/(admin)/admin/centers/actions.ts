"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";

import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import {
  addBranchToOrganization,
  createCenterWithSettings,
  transitionCenterLifecycle,
  type AddBranchResult,
  type CenterInvite,
  type CreateCenterResult,
} from "@/lib/db/platform";
import { readRasterImage, uploadCenterLogo } from "@/lib/db/storage";
import { MAX_LOGO_BYTES } from "@/lib/storage-paths";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  centerLifecycleTransitionSchema,
  centerVisibilityWindowSchema,
  copyKeysFrom,
  createCenterSchema,
} from "@/lib/validation/admin";
import type { AdminActionState } from "@/app/[locale]/(admin)/admin/centers/action-state";

/**
 * The admin panel's write path (M9, docs/00-master-product-spec.md §4.4).
 * Every action: `requirePlatformAdmin()` → zod → the real `lib/db/platform.ts`
 * function → `AuditLog` (tenant creation/lifecycle/visibility-window changes
 * are sensitive — CLAUDE.md rule 7) → `revalidatePath` (docs/02 §7).
 *
 * `requirePlatformAdmin()` redirects (never returns) for anyone whose
 * `User.isPlatformAdmin` is false, so a non-admin — including an OWNER of
 * some other center — cannot reach any of these actions at all, the same
 * shape every other route-group gate in this app already relies on.
 */

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
  const data = parsed.data;
  const { locale } = data;
  const branch = {
    name: data.name,
    nameEn: data.nameEn,
    slug: data.slug,
    themeColor: data.themeColor,
  };

  // The logo (D-25 (b)) is checked by its bytes before anything is created,
  // then stored in the private `logos` bucket under the new centre's folder.
  const logoField = formData.get("logo");
  const logo = logoField instanceof File && logoField.size > 0 ? logoField : null;
  if (logo) {
    const checked = await readRasterImage(logo, MAX_LOGO_BYTES);
    if (!checked.ok) return { fieldErrors: { logo: checked.error } };
  }

  // F1 (OD-12 (a)): a new organization founded by this branch, with its
  // founding Owner's invitation — or a branch added to an existing
  // organization within its limit, inviting nobody (its Owner already
  // resolves every branch under it).
  let invite: CenterInvite | null = null;
  let result: CreateCenterResult | AddBranchResult;
  if (data.organizationMode === "new") {
    invite = {
      email: data.ownerEmail,
      token: randomBytes(32).toString("base64url"),
      invitedBy: admin.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    };
    result = await createCenterWithSettings(prisma, {
      ...branch,
      invite,
      // A blank organization name means "the same as the branch".
      organization: data.organizationName
        ? { name: data.organizationName, nameEn: data.organizationNameEn, maxBranches: data.maxBranches }
        : { name: data.name, nameEn: data.organizationNameEn ?? data.nameEn, maxBranches: data.maxBranches },
    });
  } else {
    // U5: "Copy setup from <branch>" — moved here from the Owner's retired
    // Settings → Branches; the data layer checks the source is this
    // organization's and not deleted.
    const keys = copyKeysFrom(data);
    result = await addBranchToOrganization(prisma, {
      ...branch,
      organizationId: data.organizationId,
      copyFrom: data.copyFromCenterId ? { centerId: data.copyFromCenterId, keys } : null,
    });
  }
  if (!result.ok) {
    if (result.error === "organizationNotFound") return { fieldErrors: { organizationId: result.error } };
    if (result.error === "sourceNotFound") return { fieldErrors: { copyFromCenterId: result.error } };
    if (result.error === "slugTaken") return { fieldErrors: { slug: result.error } };
    return { error: result.error };
  }

  let logoError: string | undefined;
  if (logo) {
    const uploaded = await uploadCenterLogo(result.center.id, logo);
    if (uploaded.ok) {
      await prisma.center.update({
        where: { id: result.center.id },
        data: { logoPath: uploaded.path },
      });
    } else {
      logoError = uploaded.error;
    }
  }

  await writeAuditLog({
    centerId: result.center.id,
    actorUserId: admin.id,
    action: "platform.center.create",
    entityType: "Center",
    entityId: result.center.id,
    after: {
      slug: result.center.slug,
      lifecycleState: result.center.lifecycleState,
      organizationId: result.center.organizationId,
      newOrganization: data.organizationMode === "new",
      ...(data.organizationMode === "existing" && data.copyFromCenterId
        ? { sourceCenterId: data.copyFromCenterId, copied: "copied" in result ? result.copied : [] }
        : {}),
    },
  });

  revalidatePath(centersPath(locale));
  revalidatePath(`/${locale}${ROUTES.adminOrganizations}`);
  revalidatePath(`/${locale}${ROUTES.adminOrganization(result.center.organizationId)}`);
  // The organization's Owner sees the new branch in the switcher at once.
  revalidatePath(`/${locale}`, "layout");
  return {
    status: invite ? "created" : "branchAdded",
    ...(invite ? { invitationToken: invite.token } : {}),
    ...(logoError ? { fieldErrors: { logo: logoError } } : {}),
  };
}

/**
 * The lifecycle-state transition (M19, replacing the old activate/suspend
 * toggle) — validated against `isValidLifecycleTransition`'s table inside
 * `transitionCenterLifecycle` itself, not just in the UI that only ever
 * renders the valid next states (`lib/db/platform.ts`'s doc comment on
 * `LIFECYCLE_TRANSITIONS`).
 */
export async function transitionCenterLifecycleAction(
  _prevState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = centerLifecycleTransitionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id, to } = parsed.data;

  const before = await prisma.center.findUnique({ where: { id } });
  if (!before) return { error: "notFound" };

  const result = await transitionCenterLifecycle(prisma, id, to);
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: id,
    actorUserId: admin.id,
    action: "platform.center.lifecycle.transition",
    entityType: "Center",
    entityId: id,
    before: { lifecycleState: before.lifecycleState },
    after: { lifecycleState: to },
  });

  revalidatePath(centersPath(locale));
  revalidatePath(centerPath(locale, id));
  return { status: "saved" };
}

/**
 * The per-centre override of the data-visibility windows (M19, U6, docs/01
 * §7) — the same `CenterSettings.centerDataVisibilityDays` and
 * `teacherDataVisibilityDays` columns a centre's own `/settings` screen
 * edits, under the same caps, writable here too since the spec calls for
 * both "per-centre configurable ... AND adjustable by a platform admin".
 */
export async function updateCenterVisibilityWindowAction(
  _prevState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = centerVisibilityWindowSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, id, centerDataVisibilityDays, teacherDataVisibilityDays } = parsed.data;

  const before = await prisma.centerSettings.findUnique({ where: { centerId: id } });
  if (!before) return { error: "notFound" };

  await prisma.centerSettings.update({ where: { centerId: id }, data: { centerDataVisibilityDays, teacherDataVisibilityDays } });

  await writeAuditLog({
    centerId: id,
    actorUserId: admin.id,
    action: "platform.center.visibilityWindow.update",
    entityType: "CenterSettings",
    entityId: before.id,
    before: {
      centerDataVisibilityDays: before.centerDataVisibilityDays,
      teacherDataVisibilityDays: before.teacherDataVisibilityDays,
    },
    after: { centerDataVisibilityDays, teacherDataVisibilityDays },
  });

  revalidatePath(centerPath(locale, id));
  return { status: "saved" };
}
