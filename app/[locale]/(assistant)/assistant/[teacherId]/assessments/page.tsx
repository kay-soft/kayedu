import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FileQuestion, Plus } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { assistantAssessmentBranches } from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/scope";
import { AssessmentFilters } from "@/app/[locale]/(teacher)/teacher/assessments/assessment-filters";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { ResultsRegion } from "@/components/shared/results-region";
import { AssessmentList } from "@/components/teacher/assessment-list";
import { Card, CardContent } from "@/components/ui/card";
import { getAssistantScope } from "@/lib/auth/assistant-context";
import { assessmentResultProgress } from "@/lib/db/assessment-results";
import { listTeacherAssessments } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { assessmentRoutes, type AssessmentSurface } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("TeacherAssessments");
  return { title: t("title") };
}

/**
 * The teacher's exams and homework, for their assistant (W7b, D-W37 item 3;
 * docs/04 §11.36): the teacher's own rows at every branch where `assistantCan`
 * grants `assessments.review` (Manage covers it) — one scoped read per branch,
 * merged (U7), each within the assistant's window (D-W19). Drafts are listed
 * only with `assessments.manage` (D-W01): a Grader sees published rows only.
 * Filters as the teacher's list.
 *
 * W9 (D-W42 items 7, 9): the teacher's PERSONAL workspaces where `assistantCan`
 * grants the key are listed too, named and tagged Private, and the Branch
 * filter becomes the Source filter (branches, then workspaces).
 */
export default async function AssistantAssessmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ teacherId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { teacherId } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const query = await searchParams;
  const surface: AssessmentSurface = { kind: "assistant", teacherId };

  const reviewing = await assistantAssessmentBranches(scope, "assessments.review");
  if (reviewing.length === 0) notFound();
  const managing = new Set((await assistantAssessmentBranches(scope, "assessments.manage")).map((entry) => entry.branch.centerId));

  const withBranch = reviewing.filter((entry) => !entry.isPrivate).length > 1;
  const withSource = reviewing.length > 1;
  const named = reviewing.find((entry) => entry.branch.centerId === query.branch);
  const listed = named ? [named] : reviewing;
  const branchFilter = withSource && named ? named.branch.centerId : "";
  const type = query.type === "EXAM" || query.type === "HOMEWORK" ? query.type : undefined;

  const t = await getTranslations("TeacherAssessments");
  const tWork = await getTranslations("Assistants.work");
  const locale = await getLocale();
  const now = new Date();
  const actor = { userId: scope.user.id };

  const perBranch = await Promise.all(
    listed.map(async (entry) => {
      const rows = (await listTeacherAssessments(prisma, entry.teacher, { type, history: entry.history })).filter(
        (row) => row.status === "PUBLISHED" || managing.has(entry.branch.centerId),
      );
      return {
        entry,
        rows,
        progress: await assessmentResultProgress(prisma, actor, entry.teacher, rows.map((row) => row.id), now),
      };
    }),
  );
  const all = perBranch.flatMap(({ entry, rows, progress }) =>
    rows.map((row) => ({
      row,
      branchName: entry.branch.centerName,
      branchZone: entry.zone,
      progress: progress.get(row.id),
      isPrivate: entry.isPrivate,
    })),
  );
  const classOptions = [...new Map(all.map((item) => [item.row.classGroupId, item])).values()].map((item) => ({
    value: item.row.classGroupId,
    label: withBranch || item.isPrivate
      ? `${sessionDisplayName(locale, { classGroup: item.row.classGroup })} · ${item.branchName}`
      : sessionDisplayName(locale, { classGroup: item.row.classGroup }),
  }));
  const classFilter = classOptions.some((option) => option.value === query.class) ? query.class! : "";
  const entries = all
    .filter((item) => !classFilter || item.row.classGroupId === classFilter)
    .sort((a, b) => b.row.updatedAt.getTime() - a.row.updatedAt.getTime());
  const filtered = Boolean(type || classFilter || branchFilter);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={tWork("assessmentsSubtitle", { teacher: scope.link.teacherName })}
        action={
          managing.size > 0 ? (
            <LinkButton variant="default" href={`${assessmentRoutes(surface).newBase}?type=EXAM`}>
              <Plus className="size-4" aria-hidden />
              {t("newExam")}
            </LinkButton>
          ) : undefined
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <AssessmentFilters
            type={type ?? ""}
            classGroupId={classFilter}
            classes={classOptions}
            branches={withSource ? reviewing.filter((entry) => !entry.isPrivate).map((entry) => ({ id: entry.branch.centerId, name: entry.branch.centerName })) : []}
            workspaces={withSource ? reviewing.filter((entry) => entry.isPrivate).map((entry) => ({ id: entry.branch.centerId, name: entry.branch.centerName })) : []}
            branch={branchFilter}
          />
          <ResultsRegion className="flex flex-col gap-4">
            {entries.length === 0 ? (
              <EmptyState
                icon={<FileQuestion />}
                title={filtered ? t("emptyFiltered") : t("empty")}
                description={filtered ? undefined : tWork("assessmentsEmptyHint")}
              />
            ) : (
              <AssessmentList entries={entries} showBranch={withBranch} surface={surface} />
            )}
          </ResultsRegion>
        </CardContent>
      </Card>
    </div>
  );
}
