import { getLocale, getTranslations } from "next-intl/server";
import { SearchX, Users } from "lucide-react";

import { searchTaughtStudentsTypeAheadAction } from "@/app/[locale]/(teacher)/teacher/students/actions";
import { Pagination } from "@/components/center/pagination";
import { TypeAheadSearch } from "@/components/center/type-ahead-search";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { branchesInView, getTeacherScope, showsBranches } from "@/lib/auth/teacher-scope";
import { BranchFilter } from "@/components/teacher/branch-filter";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { teacherPortalHistoryFloor, teacherStudentProfileIds } from "@/lib/db/teacher-portal";
import { fullName, localName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { EmptyState } from "@/components/shared/empty-state";
import { ResultsRegion } from "@/components/shared/results-region";

/**
 * Every student this teacher has ever taught (spec §4.2 item 3) — never a
 * branch's full student list. `teacherStudentProfileIds` is the roster each
 * branch narrows to; search then runs inside that set.
 *
 * U7: across the branches in view, a union of per-branch scoped reads. A
 * student is a profile **at a branch**, so one who studies with this teacher
 * at two branches is listed once per branch, each naming its branch. Paging
 * runs over the branches in order (branch name): a per-branch count places
 * the page window, then only the rows on the page are read — never every
 * branch's whole roster at once.
 */
export default async function TeacherStudentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await getTeacherScope();
  const rawParams = await searchParams;
  const query = (rawParams.q ?? "").trim();
  const page = parsePageParam(rawParams.page);
  const pageSize = DEFAULT_PAGE_SIZE;
  const branches = branchesInView(scope, rawParams.branch);
  const withBranch = showsBranches(scope);
  const branchFilter = withBranch && branches.length === 1 ? branches[0].center.id : null;

  const t = await getTranslations("TeacherStudents");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const perBranch = await Promise.all(
    branches.map(async (ctx) => {
      // U6: within the teacher's own history preference (all history by default).
      const studentIds = await teacherStudentProfileIds(prisma, ctx.center.id, ctx.user.id, teacherPortalHistoryFloor(ctx));
      const where = {
        id: { in: studentIds },
        ...(query ? studentSearchWhere(query) : {}),
      };
      const count = studentIds.length > 0 ? await scoped(ctx).students.count(where) : 0;
      return { ctx, rosterSize: studentIds.length, where, count };
    }),
  );
  const rosterSize = perBranch.reduce((sum, entry) => sum + entry.rosterSize, 0);
  const total = perBranch.reduce((sum, entry) => sum + entry.count, 0);

  // The page window, placed across the branches in order.
  const rows: { row: Awaited<ReturnType<ReturnType<typeof scoped>["students"]["search"]>>[number]; branch: { id: string; name: string } }[] = [];
  let skip = (page - 1) * pageSize;
  let take = pageSize;
  for (const entry of perBranch) {
    if (take <= 0) break;
    if (skip >= entry.count) {
      skip -= entry.count;
      continue;
    }
    const found = await scoped(entry.ctx).students.search({ where: entry.where, take: Math.min(take, entry.count - skip), skip });
    rows.push(...found.map((row) => ({ row, branch: entry.ctx.center })));
    take -= found.length;
    skip = 0;
  }

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (branchFilter) params.set("branch", branchFilter);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.teacherStudents}?${qs}` : ROUTES.teacherStudents;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={withBranch ? t("subtitleAll", { count: rosterSize }) : t("subtitle", { count: rosterSize })}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TypeAheadSearch
            value={query}
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            submitLabel={t("searchSubmit")}
            search={searchTaughtStudentsTypeAheadAction}
          />

          {withBranch ? (
            <BranchFilter
              branches={scope.inView.map((ctx) => ({ id: ctx.center.id, name: ctx.center.name }))}
              value={branchFilter ?? ""}
            />
          ) : null}

          <ResultsRegion className="flex flex-col gap-4">
            {rows.length === 0 ? (
              query ? (
                <EmptyState
                  icon={<SearchX />}
                  tone="warning"
                  title={t("noMatches")}
                  description={t("noMatchesHint")}
                />
              ) : (
                <EmptyState
                  icon={<Users />}
                  title={t("empty")}
                  description={t("emptyHint")}
                />
              )
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map(({ row, branch }) => (
                  <li key={row.id}>
                    <Link
                      href={ROUTES.teacherStudent(row.id)}
                      className="flex flex-col gap-1 rounded-xl border border-border p-3 transition-ui hover:border-border-strong hover:shadow-card-hover sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {fullName(localName(row, row.user))}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                          {withBranch ? <span className="font-medium text-text-secondary">{branch.name}</span> : null}
                          <span dir="ltr">{row.studentCode}</span>
                          <span>{row.grade ? catalogLabelWithSelection(locale, row.grade) : tCommon("none")}</span>
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
          </ResultsRegion>
        </CardContent>
      </Card>
    </div>
  );
}
