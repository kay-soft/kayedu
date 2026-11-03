import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { LinkedAssessments } from "@/app/[locale]/(teacher)/teacher/assessments/linked-assessments";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ctxCan } from "@/lib/auth/tenant";
import { findInBranches, getTeacherScope, showsBranches } from "@/lib/auth/teacher-scope";
import { scoped } from "@/lib/db/scoped";
import { formatDayRange, formatTimeRange } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * One class the teacher teaches (W2): its name, branch, weekly slots and
 * period, and its exams with "New exam" (docs/04 §11.33). The class is found
 * by the same scoped lookup at each branch in view (`findInBranches`, U7) and
 * must be this teacher's own (`teacherId`) — another teacher's class, or one
 * from a branch outside the scope, is a 404 exactly like a foreign id. Owning
 * the row is the authority (U9); the assessments card adds its own gate.
 */
export default async function TeacherClassPage({ params }: { params: Promise<{ id: string }> }) {
  const scope = await getTeacherScope();
  const { id } = await params;

  const hit = await findInBranches(scope.inView, async (branch) => {
    const row = await scoped(branch).classGroups.findDetailById(id);
    return row && row.teacherId === branch.user.id ? row : null;
  });
  if (!hit) notFound();
  const { ctx, found: classGroup } = hit!;

  const t = await getTranslations("TeacherClass");
  const tDays = await getTranslations("Classes");
  const locale = await getLocale();
  const dayNames = tDays.raw("dayNames") as string[];
  const canManage = ctxCan(ctx, "assessment.manage.own");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={sessionDisplayName(locale, { classGroup })}
        description={showsBranches(scope) ? ctx.center.name : undefined}
        back={canManage ? { href: ROUTES.teacherAssessments, label: t("backToAssessments") } : { href: ROUTES.teacherSessions, label: t("backToSessions") }}
        meta={classGroup.active ? null : <Badge variant="neutral">{t("inactive")}</Badge>}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <LinkedAssessments ctx={ctx} kind="class" classGroupId={classGroup.id} canCreate={classGroup.active} />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("schedule")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {classGroup.schedules.map((slot) => (
              <div key={slot.id} className="flex justify-between gap-3">
                <span className="text-text-secondary">{dayNames[slot.dayOfWeek]}</span>
                <span className="font-medium tabular-nums text-text-primary">
                  {formatTimeRange(slot.startTime, slot.endTime, locale)}
                </span>
              </div>
            ))}
            <div className="flex justify-between gap-3">
              <span className="text-text-secondary">{t("period")}</span>
              <span className="min-w-0 text-end font-medium text-text-primary">
                {formatDayRange(classGroup.startDate, classGroup.endDate, locale)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
