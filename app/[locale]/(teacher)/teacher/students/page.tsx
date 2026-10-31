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
import { getTenantContext } from "@/lib/auth/tenant";
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
 * Every student this teacher has ever taught at the active center (spec
 * §4.2 item 3) — never the center's full student list. `teacherStudentProfileIds`
 * is the roster this narrows to; search/pagination then run inside that set.
 */
export default async function TeacherStudentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await getTenantContext("teacher");
  const rawParams = await searchParams;
  const query = (rawParams.q ?? "").trim();
  const page = parsePageParam(rawParams.page);
  const pageSize = DEFAULT_PAGE_SIZE;

  const db = scoped(ctx);
  const t = await getTranslations("TeacherStudents");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  // U6: within the teacher's own history preference (all history by default).
  const studentIds = await teacherStudentProfileIds(prisma, ctx.center.id, ctx.user.id, teacherPortalHistoryFloor(ctx));

  let rows: Awaited<ReturnType<typeof db.students.search>> = [];
  let total = 0;

  if (studentIds.length > 0) {
    const where = {
      id: { in: studentIds },
      ...(query ? studentSearchWhere(query) : {}),
    };
    [rows, total] = await Promise.all([
      db.students.search({
        where,
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      db.students.count(where),
    ]);
  }

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.teacherStudents}?${qs}` : ROUTES.teacherStudents;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: studentIds.length })} />

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
                {rows.map((row) => (
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
