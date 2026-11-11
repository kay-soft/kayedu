import { FileQuestion, Plus } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { AssessmentFilters } from "@/app/[locale]/(teacher)/teacher/assessments/assessment-filters";
import { assessmentBranches, teacherWorkspaceOptions, type WorkspaceChoice } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { AssessmentList } from "@/components/teacher/assessment-list";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { ResultsRegion } from "@/components/shared/results-region";
import { Card, CardContent } from "@/components/ui/card";
import { ctxCan, requirePermission } from "@/lib/auth/tenant";
import { firstGranting, getTeacherWorkspaceScope } from "@/lib/auth/teacher-scope";
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
 *
 * W9 (D-W42 item 7): the teacher's own PERSONAL workspaces join the union, each
 * under its own context, and the Branch filter becomes **Source** — All, each
 * branch, each workspace — beside Type and Class. A workspace row is always
 * named and tagged Private. A workspace-only teacher reaches the page
 * (`getTeacherWorkspaceScope`); the branch gate applies only when there is no
 * workspace and no granting branch.
 */
export default async function TeacherAssessmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await getTeacherWorkspaceScope();
  const params = await searchParams;

  const granting = scope.inView.filter((branch) => ctxCan(branch, "assessment.manage.own"));
  const workspaceOptions = await teacherWorkspaceOptions(scope.user.id);
  if (granting.length === 0 && workspaceOptions.length === 0 && scope.inView.length > 0) {
    // The branch gate, as before W9, when there is no workspace and no granting branch.
    const ctx = firstGranting(scope, "assessment.manage.own");
    await requirePermission(ctx, "assessment.manage.own");
  }
  const withBranch = granting.length > 1;
  const withSource = granting.length + workspaceOptions.length > 1;
  // The Source filter only narrows: a branch it names must be granting, a workspace the teacher's own.
  const namedBranch = withSource ? granting.find((branch) => branch.center.id === params.branch) : undefined;
  const namedWorkspace = withSource ? workspaceOptions.find((workspace) => workspace.id === params.branch) : undefined;
  const listed = namedBranch ? [namedBranch] : namedWorkspace ? [] : granting;
  const workspaceChoice: WorkspaceChoice = namedBranch ? "none" : namedWorkspace ? { id: namedWorkspace.id } : "all";
  const branchFilter = namedBranch?.center.id ?? namedWorkspace?.id ?? "";
  const type = params.type === "EXAM" || params.type === "HOMEWORK" ? params.type : undefined;

  const t = await getTranslations("TeacherAssessments");
  const locale = await getLocale();

  const branches = await assessmentBranches(listed, workspaceChoice);
  const now = new Date();
  const perBranch = await Promise.all(
    branches.map(async (branch) => {
      const rows = await listTeacherAssessments(prisma, branch.teacher, { type, history: branch.history });
      return { branch, rows, progress: await assessmentResultProgress(prisma, { userId: scope.user.id }, branch.teacher, rows.map((row) => row.id), now) };
    }),
  );
  const all = perBranch.flatMap(({ branch, rows, progress }) =>
    rows.map((row) => ({
      row,
      branchName: branch.ctx.center.name,
      branchZone: branch.zone,
      progress: progress.get(row.id),
      isPrivate: branch.ctx.center.kind === "PERSONAL",
    })),
  );
  const classOptions = [...new Map(all.map((entry) => [entry.row.classGroupId, entry])).values()].map((entry) => ({
    value: entry.row.classGroupId,
    label: withBranch || entry.isPrivate
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
            branches={withSource ? granting.map((branch) => ({ id: branch.center.id, name: branch.center.name })) : []}
            workspaces={withSource ? workspaceOptions : []}
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
