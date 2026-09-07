import { getLocale, getTranslations } from "next-intl/server";

import { AddStudentDialog } from "@/app/[locale]/(center)/students/add-student-dialog";
import { PromoteForm } from "@/app/[locale]/(center)/students/promote-form";
import {
  StudentRow,
  type StudentRowData,
} from "@/app/[locale]/(center)/students/student-row";
import { Pagination } from "@/components/center/pagination";
import { SearchBox } from "@/components/center/search-box";
import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabel } from "@/lib/catalog";
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
    gradeName: student.grade ? catalogLabel(locale, student.grade) : null,
    contact: student.parentPhone ?? student.phone ?? student.email,
    active: student.active,
  }));

  // `grades` comes from `scoped(ctx).grades.list()`, which already resolves
  // `.name` to this centre's own display-name override or the catalog
  // entry's bilingual name.
  const gradeOptions = grades.map((grade) => ({
    value: grade.id,
    label: grade.active ? grade.name : `${grade.name} · ${tCommon("inactive")}`,
  }));

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
        description={t("subtitle", { count: total })}
        action={<AddStudentDialog grades={gradeOptions} noneLabel={tCommon("none")} />}
      />

      {canPromote ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("promote.title")}</CardTitle>
            <CardDescription>{t("promote.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {gradeOptions.length < 2 ? (
              <FormMessage tone="info">{t("promote.needsGrades")}</FormMessage>
            ) : (
              <PromoteForm grades={gradeOptions} />
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
          <SearchBox
            value={query}
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            submitLabel={t("searchSubmit")}
          />

          {rows.length === 0 ? (
            <p className="text-sm text-text-muted">
              {query.length > 0 ? t("noMatches") : t("empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              <li
                aria-hidden
                className="hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex"
              >
                <span className="w-24 shrink-0">{t("columns.code")}</span>
                <span className="min-w-0 flex-1">{t("columns.name")}</span>
                <span className="min-w-0 flex-1">{t("columns.grade")}</span>
                <span className="min-w-0 flex-1">{t("columns.contact")}</span>
                <span className="w-24 shrink-0">{tCommon("status")}</span>
                <span className="w-44 shrink-0 text-end">
                  {tCommon("actions")}
                </span>
              </li>

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
