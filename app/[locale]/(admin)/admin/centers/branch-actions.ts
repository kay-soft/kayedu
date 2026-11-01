"use server";

import { revalidatePath } from "next/cache";

import type { BranchAdminState } from "@/app/[locale]/(admin)/admin/centers/branch-action-state";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import {
  createBranchPause,
  deleteBranch,
  endBranchPause,
  previewBranchPause,
  restoreBranch,
  updateBranchDetails,
} from "@/lib/db/branch-admin";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  branchDeleteSchema,
  branchEditSchema,
  branchPauseEndSchema,
  branchPauseSchema,
  branchRestoreSchema,
} from "@/lib/validation/admin";

/**
 * The platform admin's branch tools (U5, docs/00 §4.4): edit, pause (with a
 * preview), end a pause early, delete (typed confirmation) and restore. Every
 * action: `requirePlatformAdmin()` → zod → the real `lib/db/branch-admin.ts`
 * function, which re-checks every rule and writes its `platform.branch.*`
 * audit row in the same transaction → `revalidatePath`. No centre role has an
 * action that reaches any of this (OD-12, re-decided 29 Oct with Kamal).
 *
 * The whole locale layout is revalidated after a write a centre can see: the
 * branch switcher, the hub, the shell's pause banner and Explore all read it.
 */

function revalidateBranch(locale: string, centerId: string, organizationId?: string) {
  revalidatePath(`/${locale}`, "layout");
  revalidatePath(`/${locale}${ROUTES.adminCenter(centerId)}`);
  revalidatePath(`/${locale}${ROUTES.adminCenters}`);
  if (organizationId) revalidatePath(`/${locale}${ROUTES.adminOrganization(organizationId)}`);
}

export async function updateBranchAction(
  _state: BranchAdminState,
  formData: FormData,
): Promise<BranchAdminState> {
  const admin = await requirePlatformAdmin();
  const parsed = branchEditSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, id, ...fields } = parsed.data;

  const result = await updateBranchDetails(prisma, { centerId: id, ...fields, actorUserId: admin.id });
  if (!result.ok) return { error: result.error };
  revalidateBranch(locale, id, result.center.organizationId);
  return { status: "saved" };
}

/** Preview first ("preview" writes nothing), then the same fields with "confirm". */
export async function pauseBranchAction(
  _state: BranchAdminState,
  formData: FormData,
): Promise<BranchAdminState> {
  const admin = await requirePlatformAdmin();
  const parsed = branchPauseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, id, intent, startDate, endDate, reason } = parsed.data;

  if (intent === "preview") {
    const preview = await previewBranchPause(prisma, { centerId: id, startDate, endDate });
    if (!preview.ok) return { error: preview.error };
    return { status: "previewed", impact: preview.impact };
  }

  const result = await createBranchPause(prisma, {
    centerId: id,
    startDate,
    endDate,
    reason,
    actorUserId: admin.id,
  });
  if (!result.ok) return { error: result.error };
  revalidateBranch(locale, id);
  return { status: "paused", impact: result.impact };
}

export async function endBranchPauseAction(
  _state: BranchAdminState,
  formData: FormData,
): Promise<BranchAdminState> {
  const admin = await requirePlatformAdmin();
  const parsed = branchPauseEndSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id, pauseId } = parsed.data;

  const result = await endBranchPause(prisma, { centerId: id, pauseId, actorUserId: admin.id });
  if (!result.ok) return { error: result.error };
  revalidateBranch(locale, id);
  return {
    status: "pauseEnded",
    restored: result.restored,
    keptConflicts: result.keptConflicts,
    keptOther: result.keptOther,
  };
}

/** On success the branch's own page is gone for the centre — back to its organization. */
export async function deleteBranchAction(
  _state: BranchAdminState,
  formData: FormData,
): Promise<BranchAdminState> {
  const admin = await requirePlatformAdmin();
  const parsed = branchDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, id, confirmName } = parsed.data;

  const result = await deleteBranch(prisma, { centerId: id, confirmName, actorUserId: admin.id });
  if (!result.ok) {
    return result.error === "nameMismatch" ? { fieldErrors: { confirmName: "nameMismatch" } } : { error: result.error };
  }
  revalidateBranch(locale, id, result.center.organizationId);
  redirect({ href: ROUTES.adminOrganization(result.center.organizationId), locale });
  return {};
}

export async function restoreBranchAction(
  _state: BranchAdminState,
  formData: FormData,
): Promise<BranchAdminState> {
  const admin = await requirePlatformAdmin();
  const parsed = branchRestoreSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const result = await restoreBranch(prisma, { centerId: id, actorUserId: admin.id });
  if (!result.ok) return { error: result.error };
  revalidateBranch(locale, id, result.center.organizationId);
  return { status: "restored" };
}
