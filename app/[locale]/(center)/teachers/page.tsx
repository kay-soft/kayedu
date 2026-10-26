import { getTranslations } from "next-intl/server";

import { AddTeacherDialog } from "@/app/[locale]/(center)/teachers/add-teacher-dialog";
import { GraduationCap, SearchX } from "lucide-react";
import { searchTeachersTypeAheadAction } from "@/app/[locale]/(center)/teachers/actions";
import {
  TeacherRow,
  type TeacherRowData,
} from "@/app/[locale]/(center)/teachers/teacher-row";
import { ListHeader } from "@/components/shared/list-header";
import { Pagination } from "@/components/center/pagination";
import { TypeAheadSearch } from "@/components/center/type-ahead-search";
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
import { scoped } from "@/lib/db/scoped";
import { teacherSearchWhere } from "@/lib/db/students";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { ResultsRegion } from "@/components/shared/results-region";

/**
 * Teachers (spec §4.1 item 2) — a dashboard first: search and a paginated
 * table. A teacher here is a Membership with role TEACHER — the person is a
 * global User who may teach at several centers, and only this center's
 * relationship is managed on this screen. "Add teacher" opens a dialog
 * (docs/04 §5) instead of a form embedded in the page.
 */
export default async function TeachersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "teacher.manage");

  const { q, page: pageParam } = await searchParams;
  const query = (q ?? "").trim();
  const page = parsePageParam(pageParam);
  const pageSize = DEFAULT_PAGE_SIZE;

  const db = scoped(ctx);
  const t = await getTranslations("Teachers");
  const tCommon = await getTranslations("Settings.common");

  const where = query.length > 0 ? teacherSearchWhere(query) : undefined;

  const [teachers, total] = await Promise.all([
    db.teachers.search({
      where,
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    db.teachers.count(where),
  ]);

  // Block counts only for the teachers on this page — never the whole table.
  const blockCounts = await db.studentBlocks.countByRef(
    "TEACHER",
    teachers.map((teacher) => teacher.userId),
  );

  const rows: TeacherRowData[] = teachers.map((teacher) => ({
    membershipId: teacher.id,
    name: fullName(localName(teacher, teacher.user)),
    email: teacher.email,
    phone: teacher.phone,
    active: teacher.active,
    blockCount: blockCounts.get(teacher.userId) ?? 0,
  }));

  const canManage = ctxCan(ctx, "teacher.manage");

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.centerTeachers}?${qs}` : ROUTES.centerTeachers;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        action={<AddTeacherDialog />}
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
            search={searchTeachersTypeAheadAction}
          />

          <ResultsRegion className="flex flex-col gap-4">
            {rows.length === 0 ? (
              query.length > 0 ? (
                <EmptyState
                  icon={<SearchX />}
                  tone="warning"
                  title={t("noMatches")}
                  description={t("noMatchesHint")}
                  action={
                    <LinkButton href={ROUTES.centerTeachers} size="sm" soft>
                      {t("clearSearch")}
                    </LinkButton>
                  }
                />
              ) : (
                <EmptyState
                  icon={<GraduationCap />}
                  title={t("empty")}
                  description={t("emptyHint")}
                  action={<AddTeacherDialog />}
                />
              )
            ) : (
              <ul className="flex flex-col gap-3 md:gap-0">
                <ListHeader>
                  <span className="min-w-0 flex-1">{t("columns.name")}</span>
                  <span className="min-w-0 flex-1">{t("columns.contact")}</span>
                  <span className="min-w-0 flex-1">{t("columns.blocked")}</span>
                  <span className="w-24 shrink-0">{tCommon("status")}</span>
                  <span className="w-36 shrink-0 text-end">
                    {tCommon("actions")}
                  </span>
                </ListHeader>

                {rows.map((teacher) => (
                  <TeacherRow
                    key={teacher.membershipId}
                    teacher={teacher}
                    canManage={canManage}
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
          </ResultsRegion>
        </CardContent>
      </Card>
    </div>
  );
}
