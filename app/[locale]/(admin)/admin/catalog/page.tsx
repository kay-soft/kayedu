import { getTranslations } from "next-intl/server";

import { CatalogManager } from "@/app/[locale]/(admin)/admin/catalog/catalog-manager";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { listCatalogAdminRows } from "@/lib/db/catalog-admin";
import { prisma } from "@/lib/db/client";

/**
 * The platform admin's management screen for the global academic catalog (R8,
 * docs/00-master-product-spec.md §4.4): education systems, grades and subjects
 * — each with both names, its parent, an active badge and how many
 * branches/classes use it — plus add, edit, deactivate/reactivate and
 * delete. It replaces the M13 suggestion review queue: a centre that needs an
 * entry contacts the platform and the admin adds it here directly.
 * Platform-scoped by design — global rows have no `centerId`, exactly like
 * `/admin/centers` (docs/01 §4).
 */
export default async function AdminCatalogPage() {
  await requirePlatformAdmin();

  const t = await getTranslations("AdminCatalog");

  const [systems, grades, subjects] = await Promise.all([
    listCatalogAdminRows(prisma, "EDUCATION_SYSTEM"),
    listCatalogAdminRows(prisma, "GRADE"),
    listCatalogAdminRows(prisma, "SUBJECT"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <CatalogManager systems={systems} grades={grades} subjects={subjects} />
    </div>
  );
}
