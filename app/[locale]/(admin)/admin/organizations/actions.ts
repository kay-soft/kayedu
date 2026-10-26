"use server";

import { revalidatePath } from "next/cache";

import type { AdminActionState } from "@/app/[locale]/(admin)/admin/centers/action-state";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { updateOrganizationBranchLimit } from "@/lib/db/platform";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import { organizationBranchLimitSchema } from "@/lib/validation/admin";

/**
 * The branch-limit editor (F1, OD-12): `requirePlatformAdmin()` → zod → the
 * real `lib/db/platform.ts` function, which re-validates the number, writes it
 * and audits `platform.organization.limit.update` in one transaction →
 * `revalidatePath`. Only a platform admin ever changes an organization's limit
 * — no centre role, Owner included, has an action that writes it.
 */
export async function updateOrganizationBranchLimitAction(
  _prevState: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = organizationBranchLimitSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, id, maxBranches } = parsed.data;

  const result = await updateOrganizationBranchLimit(prisma, {
    organizationId: id,
    maxBranches,
    actorUserId: admin.id,
  });
  if (!result.ok) {
    return result.error === "invalidLimit"
      ? { fieldErrors: { maxBranches: "invalidLimit" } }
      : { error: "organizationNotFound" };
  }

  revalidatePath(`/${locale}${ROUTES.adminOrganizations}`);
  revalidatePath(`/${locale}${ROUTES.adminOrganization(id)}`);
  return { status: "saved" };
}
