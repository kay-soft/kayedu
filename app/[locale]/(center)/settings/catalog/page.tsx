import { getLocale, getTranslations } from "next-intl/server";

import {
  CatalogSection,
  type CatalogPickOption,
  type CatalogSelectionItem,
} from "@/components/settings/catalog-section";
import { SectionHeader } from "@/components/shared/section-header";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import {
  listCatalogEducationSystems,
  listCatalogGrades,
  listCatalogSubjects,
} from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";

/**
 * The academic catalog (M13, R8; docs/00-master-product-spec.md §4.1 item 10).
 * A centre picks from the platform-owned global catalog and edits only its own
 * display names (Arabic and English) + price for a pick. It cannot add or
 * correct a global entry, and there is no suggestion path: a centre that needs
 * an entry contacts the platform, and a platform admin adds it at
 * `/admin/catalog`.
 */
export default async function CatalogPage() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "center.settings.edit");

  const locale = await getLocale();
  const t = await getTranslations("Settings.catalog");
  const db = scoped(ctx);

  // The "add" lists read the global catalog's *active* entries only — a
  // deactivated one is never offered again. The centre's own picks come from
  // its selections, deactivated entries included, so history stays readable.
  const [
    centerSystems,
    centerGrades,
    centerSubjects,
    allSystems,
    allGrades,
    allSubjects,
  ] = await Promise.all([
    db.educationSystems.list(),
    db.grades.list(),
    db.subjects.list(),
    listCatalogEducationSystems(prisma),
    listCatalogGrades(prisma),
    listCatalogSubjects(prisma),
  ]);

  const selectedSystemIds = new Set(centerSystems.map((s) => s.id));
  const selectedGradeIds = new Set(centerGrades.map((g) => g.id));
  const selectedSubjectIds = new Set(centerSubjects.map((s) => s.id));

  const systemItems: CatalogSelectionItem[] = centerSystems.map((s) => ({
    selectionId: s.selectionId,
    catalogId: s.id,
    name: s.name,
    canonicalName: catalogLabel(locale, s),
    nameAr: s.nameAr,
    nameEn: s.nameEn,
    displayNameAr: s.displayNameAr,
    displayNameEn: s.displayNameEn,
    active: s.active,
    catalogActive: s.catalogActive,
    basePrice: s.basePrice,
  }));
  const gradeItems: CatalogSelectionItem[] = centerGrades.map((g) => ({
    selectionId: g.selectionId,
    catalogId: g.id,
    name: g.name,
    canonicalName: catalogLabel(locale, g),
    nameAr: g.nameAr,
    nameEn: g.nameEn,
    displayNameAr: g.displayNameAr,
    displayNameEn: g.displayNameEn,
    active: g.active,
    catalogActive: g.catalogActive,
    parentName: catalogLabelWithSelection(locale, g.educationSystem),
  }));
  // U3 — a subject is listed once; its row names which of THIS branch's
  // grades it covers (the catalog links it to, the branch picked).
  const gradeNameById = new Map(centerGrades.map((g) => [g.id, g.name]));
  const coveredGrades = (gradeIds: string[]) =>
    gradeIds.flatMap((id) => {
      const name = gradeNameById.get(id);
      return name ? [name] : [];
    });
  const subjectItems: CatalogSelectionItem[] = centerSubjects.map((s) => {
    const covered = coveredGrades(s.gradeIds);
    return {
      selectionId: s.selectionId,
      catalogId: s.id,
      name: s.name,
      canonicalName: catalogLabel(locale, s),
      nameAr: s.nameAr,
      nameEn: s.nameEn,
      displayNameAr: s.displayNameAr,
      displayNameEn: s.displayNameEn,
      active: s.active,
      catalogActive: s.catalogActive,
      parentName:
        covered.length > 0
          ? t("subjects.covers", { grades: covered.join(locale === "ar" ? "، " : ", ") })
          : t("subjects.coversNone"),
    };
  });

  const systemPickOptions: CatalogPickOption[] = allSystems
    .filter((s) => !selectedSystemIds.has(s.id))
    .map((s) => ({ value: s.id, label: catalogLabel(locale, s) }));
  const gradePickOptions: CatalogPickOption[] = allGrades
    .filter((g) => !selectedGradeIds.has(g.id))
    .map((g) => ({ value: g.id, label: catalogLabel(locale, g) }));
  const subjectPickOptions: CatalogPickOption[] = allSubjects
    .filter((s) => !selectedSubjectIds.has(s.id))
    .map((s) => ({ value: s.id, label: catalogLabel(locale, s) }));

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("title")} description={t("description")} />

      <CatalogSection
        kind="EDUCATION_SYSTEM"
        hasPricing
        items={systemItems}
        pickOptions={systemPickOptions}
        labels={{
          title: t("educationSystems.title"),
          description: t("educationSystems.description"),
          pickTitle: t("pickTitle"),
          pickPlaceholder: t("pickPlaceholder"),
          empty: t("educationSystems.empty"),
        }}
      />

      <CatalogSection
        kind="GRADE"
        hasPricing={false}
        items={gradeItems}
        pickOptions={gradePickOptions}
        labels={{
          title: t("grades.title"),
          description: t("grades.description"),
          pickTitle: t("pickTitle"),
          pickPlaceholder: t("pickPlaceholder"),
          empty: t("grades.empty"),
        }}
      />

      <CatalogSection
        kind="SUBJECT"
        hasPricing={false}
        items={subjectItems}
        pickOptions={subjectPickOptions}
        labels={{
          title: t("subjects.title"),
          description: t("subjects.description"),
          pickTitle: t("pickTitle"),
          pickPlaceholder: t("pickPlaceholder"),
          empty: t("subjects.empty"),
        }}
      />
    </div>
  );
}
