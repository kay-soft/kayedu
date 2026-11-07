import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { assessmentBranches } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { PageHeader } from "@/components/shared/page-header";
import { AssessmentResultsBody } from "@/components/teacher/assessments/assessment-results-body";
import { Badge } from "@/components/ui/badge";
import {
  RESULT_SORTS,
  RESULT_STATUSES,
  filterAndSortResults,
  type ResultSort,
  type ResultStatus,
} from "@/lib/assessment-results";
import { requirePermission } from "@/lib/auth/tenant";
import { firstGranting, getTeacherScope } from "@/lib/auth/teacher-scope";
import { readAssessmentResults } from "@/lib/db/assessment-results";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { ROUTES, TEACHER_SURFACE } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * One published exam or homework's results (W4, D-W11, D-W33; docs/04 §11.35): the
 * summary, the students, and each question's analysis. Read at the branch that
 * holds the row, among those in view: a read per branch, and the id alone decides
 * which (U7). Someone else's, another branch's, or one older than the teacher's own
 * history window is a 404. A draft has no results and opens its builder.
 */
export default async function AssessmentResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await getTeacherScope();
  const ctx = firstGranting(scope, "assessment.manage.own");
  await requirePermission(ctx, "assessment.manage.own");
  const { id } = await params;
  const query = await searchParams;
  const locale = await getLocale();

  const now = new Date();
  const branches = await assessmentBranches(scope.inView);
  const reads = await Promise.all(
    branches.map(async (branch) => ({
      branch,
      read: await readAssessmentResults(prisma, { userId: scope.user.id }, branch.teacher, id, now),
    })),
  );
  if (reads.some(({ read }) => !read.ok && read.error === "draft")) {
    return redirect({ href: ROUTES.teacherAssessment(id), locale });
  }
  const hit = reads.find(({ read }) => read.ok);
  if (!hit?.read.ok) notFound();
  const { results } = hit.read;
  const branchName = hit.branch.ctx.center.name;

  const t = await getTranslations("TeacherAssessments");
  const r = await getTranslations("TeacherAssessments.results");
  const search = (query.q ?? "").trim();
  const status = RESULT_STATUSES.includes(query.status as ResultStatus) ? (query.status as ResultStatus) : null;
  const sort = RESULT_SORTS.includes(query.sort as ResultSort) ? (query.sort as ResultSort) : "name";
  const rows = filterAndSortResults(results.students, { query: search, status, sort }, locale);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={r("title")}
        description={[results.title, sessionDisplayName(locale, { classGroup: results.classGroup }), branchName].filter(Boolean).join(" · ")}
        back={{ href: ROUTES.teacherAssessment(results.id), label: r("back") }}
        meta={
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">{t(`type.${results.type}`)}</Badge>
            <Badge variant="neutral">{results.closed ? r("closed") : r("open")}</Badge>
          </div>
        }
      />

      <AssessmentResultsBody
        results={results}
        rows={rows}
        search={search}
        status={status}
        sort={sort}
        branchName={branchName}
        surface={TEACHER_SURFACE}
      />
    </div>
  );
}
