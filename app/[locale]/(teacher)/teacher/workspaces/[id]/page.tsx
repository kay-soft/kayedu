import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { WorkspaceClassButton } from "@/components/teacher/workspaces/workspace-class-dialog";
import { weeklySlotsLine, workspaceCatalogPicker, workspaceClassLabel } from "@/components/teacher/workspaces/labels";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSection } from "@/components/shared/page-section";
import { Badge } from "@/components/ui/badge";
import { getWorkspaceContext, workspaceOffersWrites } from "@/lib/auth/workspace-context";
import { listCatalogEducationSystems, listCatalogGrades, listCatalogSubjects } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { workspaceClasses } from "@/lib/db/workspaces";
import { formatDayRange, formatMoney } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone, todayInTimezone } from "@/lib/scheduling";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Workspaces.classes");
  return { title: t("title") };
}

/**
 * A workspace's Classes (its home; W8a, D-W38 items 7 and 10). Every class is
 * the owner's, with the forced 0 cut; New class is offered only while the
 * workspace takes writes. Stacked cards at every width below `xl`.
 */
export default async function WorkspaceClassesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getWorkspaceContext(id);
  if (!ctx) notFound();
  const [t, tClasses, tCommon, locale] = await Promise.all([
    getTranslations("Workspaces.classes"),
    getTranslations("Classes"),
    getTranslations("Settings.common"),
    getLocale(),
  ]);
  const today = todayInTimezone(centreTimeZone(ctx.settings));
  const writable = workspaceOffersWrites(ctx);
  const [classes, systems, grades, subjects] = await Promise.all([
    workspaceClasses(prisma, ctx.center.id, today),
    writable ? listCatalogEducationSystems(prisma) : Promise.resolve([]),
    writable ? listCatalogGrades(prisma) : Promise.resolve([]),
    writable ? listCatalogSubjects(prisma) : Promise.resolve([]),
  ]);
  const dayNames = tClasses.raw("dayNames") as string[];
  const catalog = workspaceCatalogPicker(locale, { systems, grades, subjects }, (name) => `${name} · ${tCommon("inactive")}`);

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={writable ? <WorkspaceClassButton workspaceId={ctx.center.id} catalog={catalog} noneLabel={tCommon("none")} /> : undefined}
    >
      {classes.length === 0 ? (
        <EmptyState icon={<BookOpen />} title={t("empty")} description={writable ? t("emptyHint") : undefined} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {classes.map((row) => (
            <li key={row.id}>
              <Link
                href={ROUTES.teacherWorkspaceClass(ctx.center.id, row.id)}
                className="flex h-full flex-col gap-2 rounded-xl border border-border bg-surface p-4 transition-ui hover:border-border-strong hover:shadow-card-hover focus-ring"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0 break-words text-sm font-semibold text-text-primary">
                    {workspaceClassLabel(locale, row, t("untitled"))}
                  </span>
                  <Badge variant={row.active ? "success" : "neutral"}>{row.active ? t("active") : t("inactive")}</Badge>
                </div>
                <span className="text-xs text-text-secondary">
                  {row.schedules.length > 0 ? weeklySlotsLine(locale, dayNames, row.schedules) : t("noSlots")}
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
                  <span>{formatDayRange(row.startDate, row.endDate, locale)}</span>
                  <span>{formatMoney(row.price, locale)}</span>
                  <span>{t("upcoming", { count: row._count.sessions })}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageSection>
  );
}
