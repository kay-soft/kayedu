import { getLocale, getTranslations } from "next-intl/server";

import { AddStudentDialog } from "@/app/[locale]/(center)/students/add-student-dialog";
import { SearchX, Users } from "lucide-react";
import { PromoteForm } from "@/app/[locale]/(center)/students/promote-form";
import { searchStudentsTypeAheadAction } from "@/app/[locale]/(center)/students/actions";
import {
  StudentRow,
  type StudentRowData,
} from "@/app/[locale]/(center)/students/student-row";
import { ListHeader } from "@/components/shared/list-header";
import { Pagination } from "@/components/center/pagination";
import { TypeAheadSearch } from "@/components/center/type-ahead-search";
import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";

/**
 * Students (spec §4.1 item 4) — a dashboard first: search, filter and a
 * paginated table. "Add student" opens a dialog (docs/04 §5) rather than
 * embedding a registration form in the page, so the list is what a
 * receptionist actually lands on and a center with thousands of students
 * never loads them all at once (docs/02-architecture.md §14).
 */
export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "student.manage");

  const { q, page: pageParam } = await searchParams;
  const query = (q ?? "").trim();
  const page = parsePageParam(pageParam);
  const pageSize = DEFAULT_PAGE_SIZE;

  const db = scoped(ctx);
  const t = await getTranslations("Students");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const where = query.length > 0 ? studentSearchWhere(query) : undefined;

  const [students, total, grades] = await Promise.all([
    db.students.search({
      where,
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    db.students.count(where),
    db.grades.list(),
  ]);

  const rows: StudentRowData[] = students.map((student) => ({
    studentProfileId: student.id,
    name: fullName(localName(student, student.user)),
    studentCode: student.studentCode,
    gradeName: student.grade ? catalogLabelWithSelection(locale, student.grade) : null,
    contact: student.parentPhone ?? student.phone ?? student.email,
    active: student.active,
  }));

  // `grades` comes from `scoped(ctx).grades.list()`, which already resolves
  // `.name` to this centre's own display-name override or the catalog
  // entry's bilingual name.
  const toOption = (grade: (typeof grades)[number]) => ({
    value: grade.id,
    label: grade.active ? grade.name : `${grade.name} · ${tCommon("inactive")}`,
  });
  // New students are placed only in a grade still on offer (R8). Promotion
  // keeps every grade selectable as the source — students may still sit in a
  // grade the platform has since deactivated — and the action refuses a
  // deactivated destination.
  const gradeOptions = grades.filter((grade) => grade.catalogActive).map(toOption);
  const promoteGradeOptions = grades.map(toOption);

  const canPromote = ctxCan(ctx, "student.promote");

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.centerStudents}?${qs}` : ROUTES.centerStudents;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        // With a search, the count is the matches — say so, rather than claim
        // the branch has that many students (docs/04 §14.6).
        description={query ? t("subtitleFiltered", { count: total, query }) : t("subtitle", { count: total })}
        action={<AddStudentDialog grades={gradeOptions} noneLabel={tCommon("none")} />}
      />

      {canPromote ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("promote.title")}</CardTitle>
            <CardDescription>{t("promote.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {promoteGradeOptions.length < 2 ? (
              <FormMessage tone="info">{t("promote.needsGrades")}</FormMessage>
            ) : (
              <PromoteForm grades={promoteGradeOptions} />
            )}
          </CardContent>
        </Card>
      ) : null}

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
            search={searchStudentsTypeAheadAction}
          />

          {rows.length === 0 ? (
            query.length > 0 ? (
              <EmptyState
                icon={<SearchX />}
                tone="warning"
                title={t("noMatches")}
                description={t("noMatchesHint")}
                action={
                  <LinkButton href={ROUTES.centerStudents} size="sm">
                    {t("clearSearch")}
                  </LinkButton>
                }
              />
            ) : (
              <EmptyState
                icon={<Users />}
                title={t("empty")}
                description={t("emptyHint")}
                action={
                  <AddStudentDialog grades={gradeOptions} noneLabel={tCommon("none")} />
                }
              />
            )
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              <ListHeader>
                <span className="w-24 shrink-0">{t("columns.code")}</span>
                <span className="min-w-0 flex-1">{t("columns.name")}</span>
                <span className="min-w-0 flex-1">{t("columns.grade")}</span>
                <span className="min-w-0 flex-1">{t("columns.contact")}</span>
                <span className="w-24 shrink-0">{tCommon("status")}</span>
                <span className="w-36 shrink-0 text-end">
                  {tCommon("actions")}
                </span>
              </ListHeader>

              {rows.map((student) => (
                <StudentRow
                  key={student.studentProfileId}
                  student={student}
                  canManage={ctxCan(ctx, "student.manage")}
                />
              ))}
            </ul>
          )}

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            buildHref={buildHref}
          />
        </CardContent>
      </Card>
    </div>
  );
}
