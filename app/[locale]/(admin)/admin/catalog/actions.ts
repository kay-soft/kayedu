"use server";

import { revalidatePath } from "next/cache";

import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import {
  createCatalogEntry,
  deleteCatalogEntry,
  setCatalogEntryActive,
  updateCatalogEntry,
  type CatalogWriteError,
} from "@/lib/db/catalog-admin";
import { ROUTES } from "@/lib/routes";
import { fieldErrorsFrom } from "@/lib/validation/form";
import {
  catalogEntryCreateSchema,
  catalogEntryDeleteSchema,
  catalogEntryToggleSchema,
  catalogEntryUpdateSchema,
} from "@/lib/validation/admin";
import type { CatalogAdminActionState } from "@/app/[locale]/(admin)/admin/catalog/action-state";

/**
 * The platform admin's write path to the global academic catalog (R8,
 * docs/00-master-product-spec.md §4.4): add, edit, deactivate, reactivate and
 * delete an education system, grade or subject. Every action is
 * `requirePlatformAdmin()` → zod → `lib/db/catalog-admin.ts` (which re-checks
 * the acting user is a platform admin, enforces the rules, and writes the
 * `platform.catalog.*` audit row in the same transaction) → `revalidatePath`.
 * No centre role can reach any of this: the route group redirects them, and the
 * data layer refuses them even on a direct call.
 */

function catalogPath(locale: string) {
  return `/${locale}${ROUTES.adminCatalog}`;
}

/** Which form field a refusal belongs to, if any (the rest show above the form). */
function refusal(error: CatalogWriteError): CatalogAdminActionState {
  switch (error) {
    case "nameArRequired":
    case "nameArTooLong":
    case "duplicateNameAr":
      return { fieldErrors: { nameAr: error } };
    case "nameEnRequired":
    case "nameEnTooLong":
    case "duplicateNameEn":
      return { fieldErrors: { nameEn: error } };
    case "invalidShare":
      return { fieldErrors: { defaultFixedCenterShare: error } };
    case "parentNotFound":
      return { fieldErrors: { parentId: error } };
    default:
      return { error };
  }
}

export async function createCatalogEntryAction(
  _prevState: CatalogAdminActionState,
  formData: FormData,
): Promise<CatalogAdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = catalogEntryCreateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, kind, ...input } = parsed.data;

  const result = await createCatalogEntry(prisma, admin.id, kind, input);
  if (!result.ok) return refusal(result.error);

  revalidatePath(catalogPath(locale));
  return { status: "created" };
}

export async function updateCatalogEntryAction(
  _prevState: CatalogAdminActionState,
  formData: FormData,
): Promise<CatalogAdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = catalogEntryUpdateSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };
  const { locale, kind, id, ...input } = parsed.data;

  const result = await updateCatalogEntry(prisma, admin.id, kind, id, input);
  if (!result.ok) return refusal(result.error);

  revalidatePath(catalogPath(locale));
  return { status: "saved" };
}

/** Deactivate or reactivate — the safe alternative to deleting an entry something still uses. */
export async function toggleCatalogEntryAction(
  _prevState: CatalogAdminActionState,
  formData: FormData,
): Promise<CatalogAdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = catalogEntryToggleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, kind, id, active } = parsed.data;

  const result = await setCatalogEntryActive(prisma, admin.id, kind, id, active);
  if (!result.ok) return refusal(result.error);

  revalidatePath(catalogPath(locale));
  return { status: active ? "reactivated" : "deactivated" };
}

export async function deleteCatalogEntryAction(
  _prevState: CatalogAdminActionState,
  formData: FormData,
): Promise<CatalogAdminActionState> {
  const admin = await requirePlatformAdmin();

  const parsed = catalogEntryDeleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "notFound" };
  const { locale, kind, id } = parsed.data;

  const result = await deleteCatalogEntry(prisma, admin.id, kind, id);
  if (!result.ok) {
    return result.error === "inUse" ? { error: "inUse", usage: result.usage } : refusal(result.error);
  }

  revalidatePath(catalogPath(locale));
  return { status: "deleted" };
}
