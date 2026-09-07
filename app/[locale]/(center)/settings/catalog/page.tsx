import { getLocale, getTranslations } from "next-intl/server";

import {
  CatalogSection,
  type CatalogPickOption,
  type CatalogSelectionItem,
} from "@/components/settings/catalog-section";
import { SectionHeader } from "@/components/shared/section-header";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabel } from "@/lib/catalog";
import {
  listCatalogEducationSystems,
  listCatalogGrades,
  listCatalogSubjects,
} from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";

/**
 * The academic catalog (M13, docs/00-master-product-spec.md §4.1 item 10).
 * Replaces the three centre-authored Education Systems/Grades/Subjects
 * screens: a centre picks from the platform-owned global catalog, edits only
 * its own display name + price for a pick, and may suggest a missing or
 * wrong entry for a platform admin to review at `/admin/catalog`.
 */
export default async function CatalogPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "center.settings.edit");

  const locale = await getLocale();
  const t = await getTranslations("Settings.catalog");
  const db = scoped(ctx);

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
    name: catalogLabel(locale, s),
    displayName: s.displayName,
    active: s.active,
    basePrice: s.basePrice,
  }));
  const gradeItems: CatalogSelectionItem[] = centerGrades.map((g) => ({
    selectionId: g.selectionId,
    catalogId: g.id,
    name: catalogLabel(locale, g),
    displayName: g.displayName,
    active: g.active,
    parentName: g.educationSystemName,
  }));
  const subjectItems: CatalogSelectionItem[] = centerSubjects.map((s) => ({
    selectionId: s.selectionId,
    catalogId: s.id,
    name: catalogLabel(locale, s),
    displayName: s.displayName,
    active: s.active,
    parentName: s.gradeName,
  }));

  const systemPickOptions: CatalogPickOption[] = allSystems
    .filter((s) => !selectedSystemIds.has(s.id))
    .map((s) => ({ value: s.id, label: catalogLabel(locale, s) }));
  const gradePickOptions: CatalogPickOption[] = allGrades
    .filter((g) => !selectedGradeIds.has(g.id))
    .map((g) => ({ value: g.id, label: catalogLabel(locale, g) }));
  const subjectPickOptions: CatalogPickOption[] = allSubjects
    .filter((s) => !selectedSubjectIds.has(s.id))
    .map((s) => ({ value: s.id, label: catalogLabel(locale, s) }));

  const systemParentOptions: CatalogPickOption[] = systemItems.map((s) => ({
    value: s.catalogId,
    label: s.displayName ?? s.name,
  }));
  const gradeParentOptions: CatalogPickOption[] = gradeItems.map((g) => ({
    value: g.catalogId,
    label: g.displayName ?? g.name,
  }));

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader title={t("title")} description={t("description")} />

      <CatalogSection
        kind="EDUCATION_SYSTEM"
        hasPricing
        items={systemItems}
        pickOptions={systemPickOptions}
        parentOptions={[]}
        labels={{
          title: t("educationSystems.title"),
          description: t("educationSystems.description"),
          pickTitle: t("pickTitle"),
          pickPlaceholder: t("pickPlaceholder"),
          empty: t("educationSystems.empty"),
          suggestTitle: t("educationSystems.suggestTitle"),
          suggestDescription: t("suggestDescription"),
        }}
      />

      <CatalogSection
        kind="GRADE"
        hasPricing={false}
        items={gradeItems}
        pickOptions={gradePickOptions}
        parentOptions={systemParentOptions}
        labels={{
          title: t("grades.title"),
          description: t("grades.description"),
          pickTitle: t("pickTitle"),
          pickPlaceholder: t("pickPlaceholder"),
          empty: t("grades.empty"),
          suggestTitle: t("grades.suggestTitle"),
          suggestDescription: t("suggestDescription"),
        }}
      />

      <CatalogSection
        kind="SUBJECT"
        hasPricing={false}
        items={subjectItems}
        pickOptions={subjectPickOptions}
        parentOptions={gradeParentOptions}
        labels={{
          title: t("subjects.title"),
          description: t("subjects.description"),
          pickTitle: t("pickTitle"),
          pickPlaceholder: t("pickPlaceholder"),
          empty: t("subjects.empty"),
          suggestTitle: t("subjects.suggestTitle"),
          suggestDescription: t("suggestDescription"),
        }}
      />
    </div>
  );
}
