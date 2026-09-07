"use server";

import { revalidatePath } from "next/cache";

import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { approveCatalogSuggestion, rejectCatalogSuggestion } from "@/lib/db/catalog";
import { ROUTES } from "@/lib/routes";
import { catalogSuggestionIdSchema } from "@/lib/validation/admin";
import type { CatalogAdminActionState } from "@/app/[locale]/(admin)/admin/catalog/action-state";

/**
 * The platform-admin review queue's write path (M13,
 * docs/00-master-product-spec.md §4.4 "own the global academic catalog").
 * Approving creates or corrects the canonical catalog row — the only path in
 * this codebase allowed to write one (`lib/db/catalog.ts`'s
 * `approveCatalogSuggestion`); rejecting leaves the centre with its local
 * override only. Both are `requirePlatformAdmin()`-gated and audited.
 */

function catalogPath(locale: string) {
  return `/${locale}${ROUTES.adminCatalog}`;
}

export async function approveCatalogSuggestionAction(
  _prevState: CatalogAdminActionState,
  formData: FormData,
): Promise<CatalogAdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = catalogSuggestionIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const suggestion = await prisma.catalogSuggestion.findUnique({ where: { id } });
  if (!suggestion) return { error: "notFound" };

  const result = await approveCatalogSuggestion(prisma, id, admin.id);
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: suggestion.centerId,
    actorUserId: admin.id,
    action: "catalog.suggestion.approve",
    entityType: "CatalogSuggestion",
    entityId: id,
    before: { status: suggestion.status },
    after: { status: "ACCEPTED", catalogId: result.catalogId },
  });

  revalidatePath(catalogPath(locale));
  return { status: "approved" };
}

export async function rejectCatalogSuggestionAction(
  _prevState: CatalogAdminActionState,
  formData: FormData,
): Promise<CatalogAdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = catalogSuggestionIdSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, id } = parsed.data;

  const suggestion = await prisma.catalogSuggestion.findUnique({ where: { id } });
  if (!suggestion) return { error: "notFound" };

  const result = await rejectCatalogSuggestion(prisma, id, admin.id);
  if (!result.ok) return { error: result.error };

  await writeAuditLog({
    centerId: suggestion.centerId,
    actorUserId: admin.id,
    action: "catalog.suggestion.reject",
    entityType: "CatalogSuggestion",
    entityId: id,
    before: { status: suggestion.status },
    after: { status: "REJECTED" },
  });

  revalidatePath(catalogPath(locale));
  return { status: "rejected" };
}
