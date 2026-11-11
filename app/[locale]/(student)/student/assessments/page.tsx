import { FileQuestion } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { privateTeacherNames, studentBranches } from "@/app/[locale]/(student)/student/assessments/scope";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireStudentUser } from "@/lib/auth/tenant";
import {
  STUDENT_STATE_BADGE,
  STUDENT_STATE_ORDER,
  listStudentAssessments,
  type StudentAssessmentListItem,
} from "@/lib/db/assessment-attempts";
import { prisma } from "@/lib/db/client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone } from "@/lib/scheduling";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * Exams & homework (W3a, docs/04 §11.34): every published assessment this student
 * can see, across every branch, grouped by state and then by branch. One
 * `listStudentAssessments` per profile, unioned in memory (U7, rule 1). Each row's
 * times are in its session's frozen timezone, else its branch's.
 *
 * W9 (D-W42 item 4): a linked PERSONAL workspace is one more group, headed by
 * the workspace's name and the teacher's, tagged "Private class", its times in
 * the workspace's timezone.
 */
export default async function StudentAssessmentsPage() {
  const session = await requireStudentUser();
  const t = await getTranslations("StudentAssessments");
  const tPrivate = await getTranslations("WorkspaceStudents.student");
  const locale = await getLocale();
  const now = new Date();

  const branches = await studentBranches(session.user.id);
  const teachers = await privateTeacherNames(branches);
  const perBranch = await Promise.all(
    branches.map(async ({ ctx, student }) => ({
      centerId: ctx.center.id,
      branch: ctx.center.name,
      teacher: teachers.get(ctx.center.id) ?? null,
      zone: centreTimeZone(ctx.settings),
      items: await listStudentAssessments(prisma, student, now),
    })),
  );
  const total = perBranch.reduce((sum, branch) => sum + branch.items.length, 0);

  const timeLine = (item: StudentAssessmentListItem, branchZone: string): string => {
    const zone = item.timeZone ?? branchZone;
    if (item.type === "HOMEWORK") return item.deadline ? t("dueOn", { date: formatDateTime(item.deadline, locale, zone) }) : "";
    if (!item.windowStart || !item.windowEnd) return "";
    return t("windowLine", {
      start: formatDateTime(item.windowStart, locale, zone),
      end: formatDateTime(item.windowEnd, locale, zone),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      {total === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={<FileQuestion />} title={t("empty")} description={t("emptyHint")} />
          </CardContent>
        </Card>
      ) : (
        STUDENT_STATE_ORDER.map((state) => {
          const groups = perBranch
            .map((branch) => ({ ...branch, items: branch.items.filter((item) => item.state === state) }))
            .filter((branch) => branch.items.length > 0);
          if (groups.length === 0) return null;
          return (
            <Card key={state}>
              <CardHeader>
                <CardTitle>{t(`state.${state}`)}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {groups.map((group) => (
                  <section key={group.centerId} className="flex flex-col gap-2">
                    <h3 className="flex flex-wrap items-center gap-2 text-xs font-medium text-text-secondary">
                      <span dir="auto">{group.branch}</span>
                      {group.teacher !== null ? (
                        <>
                          <span dir="auto">{group.teacher}</span>
                          <Badge variant="neutral">{tPrivate("privateClass")}</Badge>
                        </>
                      ) : null}
                    </h3>
                    <ul className="flex flex-col gap-2">
                      {group.items.map((item) => (
                        <li key={item.id}>
                          <Link
                            href={ROUTES.studentAssessment(item.id)}
                            className="flex min-h-11 flex-col gap-1 rounded-xl border border-border p-3 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                          >
                            <span className="flex flex-wrap items-center justify-between gap-2">
                              <span dir="auto" className="min-w-0 break-words font-medium text-text-primary">{item.title}</span>
                              <Badge variant={STUDENT_STATE_BADGE[item.state]}>{t(`state.${item.state}`)}</Badge>
                            </span>
                            <span className="text-sm text-text-secondary">
                              {t(`type.${item.type}`)} · {sessionDisplayName(locale, { classGroup: item.classGroup })}
                            </span>
                            <span className="text-xs text-text-muted">{timeLine(item, group.zone)}</span>
                            {item.score ? (
                              <span className="text-sm font-medium tabular-nums text-text-primary">
                                {t("scoreLine", {
                                  score: formatNumber(item.score.score, locale),
                                  max: formatNumber(item.score.maxScore, locale),
                                  percent: formatNumber(item.score.percentage, locale),
                                })}
                              </span>
                            ) : null}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
