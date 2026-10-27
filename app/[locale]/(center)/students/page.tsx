import { getLocale, getTranslations } from "next-intl/server";

import { AddStudentDialog } from "@/app/[locale]/(center)/students/add-student-dialog";
import { ArrowUpRight, SearchX, Users } from "lucide-react";
import { searchStudentsTypeAheadAction } from "@/app/[locale]/(center)/students/actions";
import { UndoPromotionButton } from "@/app/[locale]/(center)/students/promote/undo-promotion-button";
import {
  StudentRow,
  type StudentRowData,
} from "@/app/[locale]/(center)/students/student-row";
import { ListHeader } from "@/components/shared/list-header";
import { Pagination } from "@/components/center/pagination";
import { TypeAheadSearch } from "@/components/center/type-ahead-search";
import { PageHeader } from "@/components/shared/page-header";
import { SoftLink } from "@/components/shared/soft-link";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { formatDate } from "@/lib/format";
import { isWithinUndoWindow, undoDeadline } from "@/lib/promotion";
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { ResultsRegion } from "@/components/shared/results-region";

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
  searchParams: Promise<{ q?: string; page?: string; gradeDiffers?: string }>;
}) {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "student.manage");

  const { q, page: pageParam, gradeDiffers: gradeDiffersParam } = await searchParams;
  // F4: "Grade differs from account" - students whose own account grade is set and unlike this branch's.
  const gradeDiffers = gradeDiffersParam === "1";
  const query = (q ?? "").trim();
  const page = parsePageParam(pageParam);
  const pageSize = DEFAULT_PAGE_SIZE;

  const db = scoped(ctx);
  const t = await getTranslations("Students");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const searchWhere = query.length > 0 ? studentSearchWhere(query) : undefined;
  const differingIds = gradeDiffers ? await db.students.idsGradeDiffersFromAccount() : null;
  const where =
    differingIds === null
      ? searchWhere
      : searchWhere
        ? { AND: [searchWhere, { id: { in: differingIds } }] }
        : { id: { in: differingIds } };

  const [students, total, grades, latestOpen] = await Promise.all([
    db.students.search({
      where,
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    db.students.count(where),
    db.grades.list(),
    ctxCan(ctx, "student.promote") ? db.gradePromotions.latestOpen() : null,
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

  const canPromote = ctxCan(ctx, "student.promote");
  // F4: the latest promotion, while it can still be undone (14 days).
  const now = new Date();
  const undoableBatch =
    latestOpen && isWithinUndoWindow(latestOpen.createdAt, now) ? latestOpen : null;

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (gradeDiffers) params.set("gradeDiffers", "1");
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.centerStudents}?${qs}` : ROUTES.centerStudents;
  };
  // The chip toggles its own param and keeps the search; the page resets.
  const gradeDiffersHref = (() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (!gradeDiffers) params.set("gradeDiffers", "1");
    const qs = params.toString();
    return qs ? `${ROUTES.centerStudents}?${qs}` : ROUTES.centerStudents;
  })();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        // With a search, the count is the matches — say so, rather than claim
        // the branch has that many students (docs/04 §14.6).
        description={query ? t("subtitleFiltered", { count: total, query }) : t("subtitle", { count: total })}
        action={
          <div className="flex flex-col gap-2 sm:flex-row">
            {canPromote ? (
              <LinkButton href={ROUTES.centerStudentsPromote} className="w-full sm:w-auto">
                <ArrowUpRight className="size-4" aria-hidden />
                {t("promote.open")}
              </LinkButton>
            ) : null}
            <AddStudentDialog grades={gradeOptions} noneLabel={tCommon("none")} />
          </div>
        }
      />

      {canPromote && undoableBatch ? (
        <PromotionBanner
          title={t("promote.bannerTitle", {
            date: formatDate(undoableBatch.createdAt, locale),
            from: catalogLabelWithSelection(locale, undoableBatch.fromGrade) ?? "",
            to: catalogLabelWithSelection(locale, undoableBatch.toGrade) ?? "",
            count: undoableBatch._count.items,
          })}
          hint={t("promote.bannerHint", { date: formatDate(undoDeadline(undoableBatch.createdAt), locale) })}
        >
          <UndoPromotionButton
            batchId={undoableBatch.id}
            fromLabel={catalogLabelWithSelection(locale, undoableBatch.fromGrade) ?? ""}
            toLabel={catalogLabelWithSelection(locale, undoableBatch.toGrade) ?? ""}
          />
        </PromotionBanner>
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

          <nav aria-label={t("filtersLabel")} className="flex flex-wrap gap-2">
            <SoftLink
              href={gradeDiffersHref}
              aria-pressed={gradeDiffers}
              className={cn(
                "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium transition-ui-fast",
                gradeDiffers
                  ? "border-brand bg-brand text-brand-foreground"
                  : "border-border bg-surface text-text-secondary hover:border-brand hover:text-text-primary",
              )}
            >
              {t("gradeDiffersChip")}
            </SoftLink>
          </nav>

          <ResultsRegion className="flex flex-col gap-4">
            {rows.length === 0 ? (
              query.length > 0 ? (
                <EmptyState
                  icon={<SearchX />}
                  tone="warning"
                  title={t("noMatches")}
                  description={t("noMatchesHint")}
                  action={
                    <LinkButton href={ROUTES.centerStudents} size="sm" soft>
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
          </ResultsRegion>
        </CardContent>
      </Card>
    </div>
  );
}

/** The "latest promotion - undo it until ..." strip (F4): amber for a pending action, with the verb beside the facts. */
function PromotionBanner({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-xl border border-warning/30 bg-warning-bg p-4 text-warning-fg sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-semibold break-words">{title}</p>
        <p className="text-xs">{hint}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
