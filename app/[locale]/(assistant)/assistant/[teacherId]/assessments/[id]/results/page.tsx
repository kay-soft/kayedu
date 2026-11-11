import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { assistantAssessmentBranches } from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/scope";
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
import { getAssistantScope, scopeBranches, scopeWorkspaces } from "@/lib/auth/assistant-context";
import { readAssessmentResults } from "@/lib/db/assessment-results";
import { prisma } from "@/lib/db/client";
import { redirect } from "@/lib/i18n/navigation";
import { assessmentRoutes, type AssessmentSurface } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * One published assessment's results, for the teacher's assistant (W7b, D-W37
 * item 3): `assessments.review` or `assessments.manage`. The W4 read runs with
 * actor = the assistant and the teacher's membership; it re-checks the
 * assistant itself and applies the assistant's window (D-W19), so a direct URL
 * gets nothing more. A read per branch; the id alone decides which (U7).
 */
export default async function AssistantAssessmentResultsPage({
  params,
  searchParams,
}: {
  params: Promise<{ teacherId: string; id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { teacherId, id } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const query = await searchParams;
  const locale = await getLocale();
  const surface: AssessmentSurface = { kind: "assistant", teacherId };
  const routes = assessmentRoutes(surface);

  const now = new Date();
  const branches = await assistantAssessmentBranches(scope, "assessments.review");
  const reads = await Promise.all(
    branches.map(async (entry) => ({
      entry,
      read: await readAssessmentResults(prisma, { userId: scope.user.id }, entry.teacher, id, now),
    })),
  );
  if (reads.some(({ read }) => !read.ok && read.error === "draft")) {
    // A draft has no results: its builder, for an assistant who may manage it (D-W01).
    if (scopeBranches(scope, "assessments.manage").length === 0 && scopeWorkspaces(scope, "assessments.manage").length === 0) notFound();
    return redirect({ href: routes.detail(id), locale });
  }
  const hit = reads.find(({ read }) => read.ok);
  if (!hit?.read.ok) notFound();
  const { results } = hit.read;
  const branchName = hit.entry.branch.centerName;

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
        back={{ href: routes.list, label: r("back") }}
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
        surface={surface}
      />
    </div>
  );
}
