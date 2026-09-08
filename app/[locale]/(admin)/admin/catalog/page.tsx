import { getLocale, getTranslations } from "next-intl/server";
import { Library } from "lucide-react";

import { SuggestionRow } from "@/app/[locale]/(admin)/admin/catalog/suggestion-row";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/tenant";
import { catalogLabel } from "@/lib/catalog";
import { listPendingCatalogSuggestions } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { formatDate } from "@/lib/format";
import { EmptyState } from "@/components/shared/empty-state";

/**
 * The platform-admin review queue (M13, docs/00-master-product-spec.md §4.4
 * "own the global academic catalog"). Platform-scoped by design — spans
 * every centre's suggestions, exactly like `/admin/centers` (docs/01 §4).
 */
export default async function AdminCatalogPage() {
  await requirePlatformAdmin();

  const locale = await getLocale();
  const t = await getTranslations("AdminCatalog");

  const suggestions = await listPendingCatalogSuggestions(prisma);

  const rows = await Promise.all(
    suggestions.map(async (suggestion) => {
      let targetName: string | null = null;
      let parentName: string | null = null;

      if (suggestion.kind === "EDUCATION_SYSTEM") {
        if (suggestion.targetId) {
          const row = await prisma.catalogEducationSystem.findUnique({
            where: { id: suggestion.targetId },
          });
          targetName = row ? catalogLabel(locale, row) : null;
        }
      } else if (suggestion.kind === "GRADE") {
        const [target, parent] = await Promise.all([
          suggestion.targetId
            ? prisma.catalogGrade.findUnique({ where: { id: suggestion.targetId } })
            : null,
          suggestion.parentId
            ? prisma.catalogEducationSystem.findUnique({ where: { id: suggestion.parentId } })
            : null,
        ]);
        targetName = target ? catalogLabel(locale, target) : null;
        parentName = parent ? catalogLabel(locale, parent) : null;
      } else {
        const [target, parent] = await Promise.all([
          suggestion.targetId
            ? prisma.catalogSubject.findUnique({ where: { id: suggestion.targetId } })
            : null,
          suggestion.parentId
            ? prisma.catalogGrade.findUnique({ where: { id: suggestion.parentId } })
            : null,
        ]);
        targetName = target ? catalogLabel(locale, target) : null;
        parentName = parent ? catalogLabel(locale, parent) : null;
      }

      return { suggestion, targetName, parentName };
    }),
  );

  const kindLabel = (kind: (typeof suggestions)[number]["kind"]) =>
    kind === "EDUCATION_SYSTEM"
      ? t("kinds.educationSystem")
      : kind === "GRADE"
        ? t("kinds.grade")
        : t("kinds.subject");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: rows.length })} />

      {rows.length === 0 ? (
        <EmptyState compact icon={<Library />} title={t("empty")} description={t("emptyHint")} />
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map(({ suggestion, targetName, parentName }) => (
            <Card key={suggestion.id}>
              <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                <div className="min-w-0">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <Badge variant="info">{kindLabel(suggestion.kind)}</Badge>
                    {targetName ? t("correctionOf", { name: targetName }) : t("newEntry")}
                  </CardTitle>
                  <p className="mt-1 text-xs text-text-muted">
                    {suggestion.center.name}
                    {" · "}
                    {formatDate(suggestion.createdAt, locale)}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-xs text-text-muted">{t("fields.nameAr")}</span>
                    <p dir="rtl" className="text-text-primary">
                      {suggestion.proposedNameAr}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-text-muted">{t("fields.nameEn")}</span>
                    <p dir="ltr" className="text-text-primary">
                      {suggestion.proposedNameEn}
                    </p>
                  </div>
                </div>
                {parentName ? (
                  <p className="text-xs text-text-secondary">
                    {t("fields.parent")}: {parentName}
                  </p>
                ) : null}
                {suggestion.note ? (
                  <p className="text-sm text-text-secondary">{suggestion.note}</p>
                ) : null}
                <SuggestionRow suggestionId={suggestion.id} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
