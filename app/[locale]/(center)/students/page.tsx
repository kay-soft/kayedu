import { getTranslations } from "next-intl/server";

import { PromoteForm } from "@/app/[locale]/(center)/students/promote-form";
import { StudentForm } from "@/app/[locale]/(center)/students/student-form";
import {
  StudentRow,
  type StudentRowData,
} from "@/app/[locale]/(center)/students/student-row";
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
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { fullName } from "@/lib/identity";

/** Enough for a desk to work with; the search narrows anything bigger. */
const PAGE_SIZE = 50;

/**
 * Students (spec §4.1 item 4). Registering, searching, promoting — the list a
 * receptionist lives in. Every read and write is centerId-scoped through
 * `scoped(ctx)`; the search itself runs in the database, not in memory.
 */
export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await getTenantContext({ experience: "center" });
  await requirePermission(ctx, "student.manage");

  const { q } = await searchParams;
  const query = (q ?? "").trim();

  const db = scoped(ctx);
  const t = await getTranslations("Students");
  const tCommon = await getTranslations("Settings.common");

  const where = query.length > 0 ? studentSearchWhere(query) : undefined;

  const [students, total, grades] = await Promise.all([
    db.students.search({ where, take: PAGE_SIZE }),
    db.students.count(where),
    db.grades.list(),
  ]);

  const rows: StudentRowData[] = students.map((student) => ({
    studentProfileId: student.id,
    name: fullName(student.user),
    studentCode: student.studentCode,
    gradeName: student.grade?.name ?? null,
    contact: student.parentPhone ?? student.user.phone ?? student.user.email,
    active: student.active,
  }));

  const gradeOptions = grades.map((grade) => ({
    value: grade.id,
    label: grade.active
      ? grade.name
      : `${grade.name} · ${tCommon("inactive")}`,
  }));

  const canPromote = ctxCan(ctx, "student.promote");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle", { count: total })}
      />

      <StudentForm
        grades={gradeOptions}
        studentCount={total}
        noneLabel={tCommon("none")}
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

          {total > rows.length ? (
            <p className="text-sm text-text-muted">
              {t("moreResults", { shown: rows.length, total })}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
