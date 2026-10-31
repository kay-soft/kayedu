import { cache } from "react";
import type { Metadata } from "next";
import { PausedNote } from "@/components/explore/paused-note";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { SearchX } from "lucide-react";

import { Pagination } from "@/components/center/pagination";
import { ClassCard } from "@/components/explore/class-card";
import { EnrolAction, seatBadge } from "@/components/explore/enrol-action";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { ResultsRegion } from "@/components/shared/results-region";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { branchName } from "@/lib/branch-name";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import {
  EXPLORE_CLASS_PAGE_SIZE,
  publicBranchBySlug,
  publicClassesForBranch,
  publicTeachersOf,
} from "@/lib/db/public-catalog";
import { formatRating } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { nameInitial } from "@/lib/initials";
import { ROUTES } from "@/lib/routes";
import { parsePageParam } from "@/lib/validation/people";

type Params = { params: Promise<{ slug: string }> };

/** Once per request — the metadata and the page share it. */
const loadBranch = cache((slug: string) => publicBranchBySlug(prisma, decodeURIComponent(slug)));

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const branch = await loadBranch(slug);
  if (!branch) return {};
  return { title: branchName(await getLocale(), branch) };
}

/**
 * A listed branch (F5): its name and logo, its listed classes, and the
 * teachers of those classes. An unlisted, ONBOARDING, SUSPENDED or ARCHIVED
 * branch is a 404.
 */
export default async function ExploreBranchPage({
  params,
  searchParams,
}: Params & { searchParams: Promise<Record<string, string | undefined>> }) {
  const { slug } = await params;
  const branch = await loadBranch(slug);
  if (!branch) notFound();

  const raw = await searchParams;
  const page = parsePageParam(raw.page);
  const locale = await getLocale();
  const t = await getTranslations("Explore");
  const tCard = await getTranslations("Explore.card");

  const now = new Date();
  const [classes, user] = await Promise.all([publicClassesForBranch(prisma, branch, now), getCurrentUser()]);
  const teachers = publicTeachersOf(classes);
  const name = branchName(locale, branch);

  const total = classes.length;
  const pageEntries = classes.slice((page - 1) * EXPLORE_CLASS_PAGE_SIZE, page * EXPLORE_CLASS_PAGE_SIZE);
  const buildHref = (target: number) =>
    target > 1 ? `${ROUTES.exploreBranch(branch.slug)}?page=${target}` : ROUTES.exploreBranch(branch.slug);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={name}
        description={t("branch.subtitle")}
        back={{ href: ROUTES.explore, label: t("backToExplore") }}
        leading={<BrandAvatar name={name} logoUrl={branch.logoUrl} themeColor={branch.themeColor} size="lg" />}
        meta={branch.pausedUntil ? <PausedNote until={branch.pausedUntil} /> : undefined}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <section aria-labelledby="branch-classes" className="flex flex-col gap-4 lg:col-span-2">
          <h2 id="branch-classes" className="text-lg font-semibold text-text-primary">
            {t("branch.classesTitle")}
          </h2>
          <ResultsRegion className="flex flex-col gap-6">
            {pageEntries.length === 0 ? (
              <EmptyState icon={<SearchX />} title={t("branch.classesEmpty")} />
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {await Promise.all(
                  pageEntries.map(async (item) => {
                    const href = ROUTES.exploreClass(branch.slug, item.id);
                    return (
                      <ClassCard
                        key={item.id}
                        href={href}
                        subjectName={catalogLabelWithSelection(locale, item.subject)}
                        branchName={name}
                        pausedUntil={branch.pausedUntil}
                        teacherName={item.teacherName}
                        teacherRating={item.teacherRating}
                        gradeName={catalogLabelWithSelection(locale, item.grade)}
                        schedules={item.schedules}
                        price={item.price}
                        badge={await seatBadge(item.seats)}
                        action={
                          <EnrolAction
                            signedIn={Boolean(user)}
                            centerId={branch.id}
                            classId={item.id}
                            requiresConfirmation={item.requiresConfirmation}
                            seats={item.seats}
                            returnPath={href}
                          />
                        }
                      />
                    );
                  }),
                )}
              </div>
            )}
            <Pagination page={page} pageSize={EXPLORE_CLASS_PAGE_SIZE} total={total} buildHref={buildHref} />
          </ResultsRegion>
        </section>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>{t("branch.teachersTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {teachers.length === 0 ? (
              <p className="text-sm text-text-muted">{t("branch.teachersEmpty")}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {teachers.map((teacher) => (
                  <li key={teacher.teacherUserId}>
                    <Link
                      href={ROUTES.exploreTeacher(branch.slug, teacher.teacherUserId)}
                      className="flex min-h-11 items-center gap-3 rounded-lg px-2 focus-ring hover:bg-surface-hover"
                    >
                      <span
                        aria-hidden
                        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-brand-foreground"
                      >
                        {nameInitial(teacher.name)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                        {teacher.name}
                      </span>
                      {teacher.rating !== null ? (
                        <span className="shrink-0 text-xs font-medium text-text-muted">
                          {tCard("rating", { value: formatRating(teacher.rating, locale) })}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

