import { FileQuestion, Plus } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { AssessmentFilters } from "@/app/[locale]/(teacher)/teacher/assessments/assessment-filters";
import { assessmentBranches } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { AssessmentList } from "@/components/teacher/assessment-list";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { ResultsRegion } from "@/components/shared/results-region";
import { Card, CardContent } from "@/components/ui/card";
import { ctxCan, requirePermission } from "@/lib/auth/tenant";
import { branchesInView, firstGranting, getTeacherScope } from "@/lib/auth/teacher-scope";
import { assessmentResultProgress } from "@/lib/db/assessment-results";
import { listTeacherAssessments } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { ROUTES } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * The teacher's exams and homework (W2, D-W30; docs/04 §11.33). Opens when any
 * branch in view grants `assessment.manage.own`; lists the teacher's own rows
 * at every granting branch — one scoped read per branch, merged (U7) — with
 * Type, Class and (under All branches) Branch filters. W4: a published row shows
 * "submitted / eligible" and its Results action, and one older than the teacher's
 * own history window is not listed (D-W33).
 */
export default async function TeacherAssessmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await getTeacherScope();
  const ctx = firstGranting(scope, "assessment.manage.own");
  await requirePermission(ctx, "assessment.manage.own");
  const params = await searchParams;

  const granting = scope.inView.filter((branch) => ctxCan(branch, "assessment.manage.own"));
  const withBranch = granting.length > 1;
  const listed = branchesInView({ ...scope, inView: granting }, params.branch);
  const branchFilter = withBranch && listed.length === 1 ? listed[0].center.id : "";
  const type = params.type === "EXAM" || params.type === "HOMEWORK" ? params.type : undefined;

  const t = await getTranslations("TeacherAssessments");
  const locale = await getLocale();

  const branches = await assessmentBranches(listed);
  const now = new Date();
  const perBranch = await Promise.all(
    branches.map(async (branch) => {
      const rows = await listTeacherAssessments(prisma, branch.teacher, { type, history: branch.history });
      return { branch, rows, progress: await assessmentResultProgress(prisma, { userId: scope.user.id }, branch.teacher, rows.map((row) => row.id), now) };
    }),
  );
  const all = perBranch.flatMap(({ branch, rows, progress }) =>
    rows.map((row) => ({ row, branchName: branch.ctx.center.name, branchZone: branch.zone, progress: progress.get(row.id) })),
  );
  const classOptions = [...new Map(all.map((entry) => [entry.row.classGroupId, entry])).values()].map((entry) => ({
    value: entry.row.classGroupId,
    label: withBranch
      ? `${sessionDisplayName(locale, { classGroup: entry.row.classGroup })} · ${entry.branchName}`
      : sessionDisplayName(locale, { classGroup: entry.row.classGroup }),
  }));
  const classFilter = classOptions.some((option) => option.value === params.class) ? params.class! : "";
  const entries = all
    .filter((entry) => !classFilter || entry.row.classGroupId === classFilter)
    .sort((a, b) => b.row.updatedAt.getTime() - a.row.updatedAt.getTime());
  const filtered = Boolean(type || classFilter || branchFilter);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        action={
          <LinkButton variant="default" href={`${ROUTES.teacherAssessmentNew}?type=EXAM`}>
            <Plus className="size-4" aria-hidden />
            {t("newExam")}
          </LinkButton>
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <AssessmentFilters
            type={type ?? ""}
            classGroupId={classFilter}
            classes={classOptions}
            branches={withBranch ? granting.map((branch) => ({ id: branch.center.id, name: branch.center.name })) : []}
            branch={branchFilter}
          />
          <ResultsRegion className="flex flex-col gap-4">
            {entries.length === 0 ? (
              <EmptyState
                icon={<FileQuestion />}
                title={filtered ? t("emptyFiltered") : t("empty")}
                description={filtered ? undefined : t("emptyHint")}
              />
            ) : (
              <AssessmentList entries={entries} showBranch={withBranch} />
            )}
          </ResultsRegion>
        </CardContent>
      </Card>
    </div>
  );
}
