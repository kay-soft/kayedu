import type { Metadata } from "next";
import { PausedNote } from "@/components/explore/paused-note";
import { getLocale, getTranslations } from "next-intl/server";
import { Building2, SearchX } from "lucide-react";

import { DiscoverFilters } from "@/app/[locale]/(student)/student/discover/discover-filters";
import { Pagination } from "@/components/center/pagination";
import { ClassCard, ClassCardGrid } from "@/components/explore/class-card";
import { EnrolAction, seatBadge } from "@/components/explore/enrol-action";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ResultsRegion } from "@/components/shared/results-region";
import { SoftLink } from "@/components/shared/soft-link";
import { getCurrentUser } from "@/lib/auth/session";
import { branchName } from "@/lib/branch-name";
import { catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import {
  EXPLORE_BRANCH_PAGE_SIZE,
  EXPLORE_CLASS_PAGE_SIZE,
  listPublicBranches,
  publicFilterOptions,
  searchPublicClasses,
} from "@/lib/db/public-catalog";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { EXPLORE_VIEWS, parseExploreFilters, parseExploreView, type ExploreView } from "@/lib/validation/explore";
import { parsePageParam } from "@/lib/validation/people";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Explore");
  return { title: t("title") };
}

/**
 * Explore (F5): the public front door — listed branches, and a class search
 * across them by subject, grade and day. No sign-in; sign-in is asked for only
 * when someone enrols. Every read is `lib/db/public-catalog.ts`.
 */
export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const raw = await searchParams;
  const filters = parseExploreFilters(raw);
  const view = parseExploreView(raw, filters);
  const page = parsePageParam(raw.page);

  const t = await getTranslations("Explore");
  const tFilters = await getTranslations("StudentDiscover.filters");
  const tClasses = await getTranslations("Classes");
  const locale = await getLocale();

  const viewHref = (target: ExploreView) => `${ROUTES.explore}?view=${target}`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <nav aria-label={t("viewsLabel")} className="flex flex-wrap gap-2">
        {EXPLORE_VIEWS.map((kind) => (
          <SoftLink
            key={kind}
            href={viewHref(kind)}
            aria-current={kind === view ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-ui-fast",
              kind === view
                ? "border-brand bg-brand text-brand-foreground"
                : "border-border bg-surface text-text-secondary hover:border-brand hover:text-text-primary",
            )}
          >
            {t(`views.${kind}`)}
          </SoftLink>
        ))}
      </nav>

      {view === "branches" ? (
        <BranchesView page={page} />
      ) : (
        <ClassesView
          page={page}
          filters={filters}
          dayNames={tClasses.raw("dayNames") as string[]}
          allLabel={tFilters("all")}
          locale={locale}
        />
      )}
    </div>
  );
}

async function BranchesView({ page }: { page: number }) {
  const t = await getTranslations("Explore");
  const locale = await getLocale();
  const { branches, total } = await listPublicBranches(prisma, page);

  const buildHref = (target: number) =>
    target > 1 ? `${ROUTES.explore}?view=branches&page=${target}` : `${ROUTES.explore}?view=branches`;

  return (
    <ResultsRegion className="flex flex-col gap-6">
      {branches.length === 0 ? (
        <EmptyState icon={<Building2 />} title={t("branchesEmpty")} description={t("branchesEmptyHint")} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {branches.map((branch) => {
            const name = branchName(locale, branch);
            return (
              <li key={branch.slug}>
                <Link
                  href={ROUTES.exploreBranch(branch.slug)}
                  className="flex min-h-16 items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-card transition-ui focus-ring hover:border-border-strong hover:shadow-card-hover"
                >
                  <BrandAvatar name={name} logoUrl={branch.logoUrl} themeColor={branch.themeColor} size="lg" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-text-primary">{name}</span>
                    {branch.pausedUntil ? (
                      <PausedNote until={branch.pausedUntil} />
                    ) : (
                      <span className="block truncate text-sm text-text-muted">{t("branchCardHint")}</span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Pagination page={page} pageSize={EXPLORE_BRANCH_PAGE_SIZE} total={total} buildHref={buildHref} />
    </ResultsRegion>
  );
}

async function ClassesView({
  page,
  filters,
  dayNames,
  allLabel,
  locale,
}: {
  page: number;
  filters: ReturnType<typeof parseExploreFilters>;
  dayNames: string[];
  allLabel: string;
  locale: string;
}) {
  const t = await getTranslations("Explore");
  const now = new Date();
  const [classes, options, user] = await Promise.all([
    searchPublicClasses(prisma, now, filters),
    publicFilterOptions(prisma),
    getCurrentUser(),
  ]);

  const total = classes.length;
  const pageEntries = classes.slice((page - 1) * EXPLORE_CLASS_PAGE_SIZE, page * EXPLORE_CLASS_PAGE_SIZE);

  const subjectOptions = options.subjects
    .map((entry) => ({ value: entry.id, label: catalogLabel(locale, entry), gradeIds: entry.gradeIds }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const gradeOptions = options.grades
    .map((entry) => ({ value: entry.id, label: catalogLabel(locale, entry) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const buildHref = (target: number) => {
    const params = new URLSearchParams({ view: "classes" });
    if (filters.subjectId) params.set("subject", filters.subjectId);
    if (filters.gradeId) params.set("grade", filters.gradeId);
    if (filters.day !== undefined) params.set("day", String(filters.day));
    if (target > 1) params.set("page", String(target));
    return `${ROUTES.explore}?${params.toString()}`;
  };

  return (
    <>
      <DiscoverFilters
        subject={filters.subjectId ?? ""}
        grade={filters.gradeId ?? ""}
        day={filters.day !== undefined ? String(filters.day) : ""}
        subjects={subjectOptions}
        grades={gradeOptions}
        dayNames={dayNames}
        allLabel={allLabel}
      />

      <ResultsRegion className="flex flex-col gap-6">
        <p className="text-sm text-text-muted">{t("classesFound", { count: total })}</p>
        {pageEntries.length === 0 ? (
          <EmptyState icon={<SearchX />} tone="warning" title={t("classesEmpty")} description={t("classesEmptyHint")} />
        ) : (
          <ClassCardGrid>
            {await Promise.all(
              pageEntries.map(async (item) => {
                const href = ROUTES.exploreClass(item.branch.slug, item.id);
                return (
                  <ClassCard
                    key={`${item.branch.slug}:${item.id}`}
                    href={href}
                    subjectName={catalogLabelWithSelection(locale, item.subject)}
                    branchName={branchName(locale, item.branch)}
                    pausedUntil={item.branch.pausedUntil}
                    teacherName={item.teacherName}
                    imageUrl={item.imageUrl}
                    teacherRating={item.teacherRating}
                    gradeName={catalogLabelWithSelection(locale, item.grade)}
                    schedules={item.schedules}
                    price={item.price}
                    badge={await seatBadge(item.seats)}
                    action={
                      <EnrolAction
                        signedIn={Boolean(user)}
                        centerId={item.branch.id}
                        classId={item.id}
                        requiresConfirmation={item.requiresConfirmation}
                        seats={item.seats}
                        returnPath={href}
                        item={item}
                        branchLabel={branchName(locale, item.branch)}
                      />
                    }
                  />
                );
              }),
            )}
          </ClassCardGrid>
        )}
        <Pagination page={page} pageSize={EXPLORE_CLASS_PAGE_SIZE} total={total} buildHref={buildHref} />
      </ResultsRegion>
    </>
  );
}
