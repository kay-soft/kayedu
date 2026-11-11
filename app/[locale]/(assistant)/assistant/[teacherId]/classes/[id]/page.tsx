import { notFound } from "next/navigation";
import { CalendarDays, Plus, Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { findAtBranches, getAssistantScope, scopeBranches, scopeCan } from "@/lib/auth/assistant-context";
import { assistantClassDetail } from "@/lib/db/assistant-reads";
import { prisma } from "@/lib/db/client";
import { deriveSessionDisplayStatus } from "@/lib/db/sessions";
import { formatDay, formatDayRange, formatTimeRange } from "@/lib/format";
import { fullName } from "@/lib/identity";
import { ROUTES, assessmentRoutes } from "@/lib/routes";
import { sessionDisplayName } from "@/lib/session-label";

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

/**
 * One of the teacher's classes, for their assistant (W7b, D-W37 item 4) —
 * read-only: its schedule and period, the teacher's own sessions of it inside
 * the assistant's window (D-W19), and the roster's **names only**. Found at
 * the branch that holds it among those granting `classes.view`; another
 * teacher's class, or one at a branch with assistants off, is a 404. With
 * `assessments.manage` there it also offers New exam and, per session, Add
 * homework — links into the assessment builder, which re-checks everything.
 */
export default async function AssistantClassPage({ params }: { params: Promise<{ teacherId: string; id: string }> }) {
  const { teacherId, id } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();

  const hit = await findAtBranches(scopeBranches(scope, "classes.view"), (branch) =>
    assistantClassDetail(prisma, { centerId: branch.centerId, teacherUserId: teacherId, classGroupId: id, floor: branch.floor }),
  );
  if (!hit) notFound();
  const { branch, found } = hit!;
  const { classGroup, sessions, roster } = found;

  const t = await getTranslations("Assistants.work.classes");
  const tDays = await getTranslations("Classes");
  const tStatus = await getTranslations("Sessions.status");
  const tAssess = await getTranslations("TeacherAssessments");
  const locale = await getLocale();
  const dayNames = tDays.raw("dayNames") as string[];
  const now = new Date();
  const canManage = scopeCan(scope, "assessments.manage", branch.centerId);
  const routes = assessmentRoutes({ kind: "assistant", teacherId });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={sessionDisplayName(locale, { classGroup })}
        description={scope.branches.length > 1 ? branch.centerName : undefined}
        back={{ href: ROUTES.assistantClasses(teacherId), label: t("back") }}
        meta={classGroup.active ? null : <Badge variant="neutral">{t("inactive")}</Badge>}
        action={
          canManage && classGroup.active ? (
            <LinkButton href={`${routes.newBase}?type=EXAM&class=${encodeURIComponent(classGroup.id)}`}>
              <Plus className="size-4" aria-hidden />
              {tAssess("newExam")}
            </LinkButton>
          ) : undefined
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <Card>
          <CardHeader>
            <CardTitle as="h2">{t("sessionsTitle")}</CardTitle>
            <CardDescription>{t("sessionsHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            {sessions.length === 0 ? (
              <EmptyState compact icon={<CalendarDays />} title={t("noSessions")} />
            ) : (
              <ul className="flex flex-col gap-2">
                {sessions.map((session) => {
                  const display = deriveSessionDisplayStatus(session, now, branch.zone);
                  const open = display !== "CANCELLED" && display !== "RESCHEDULED";
                  return (
                    <li
                      key={session.id}
                      className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 text-sm">
                        <p className="font-medium text-text-primary">{formatDay(session.date, locale)}</p>
                        <p className="text-xs text-text-muted" dir="ltr">
                          {formatTimeRange(session.startTime, session.endTime, locale)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Badge variant={STATUS_BADGE[display]}>{tStatus(display)}</Badge>
                        {canManage && open && classGroup.active ? (
                          <LinkButton href={`${routes.newBase}?type=HOMEWORK&session=${encodeURIComponent(session.id)}`}>
                            <Plus className="size-4" aria-hidden />
                            {t("addHomework")}
                          </LinkButton>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t("schedule")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              {classGroup.schedules.map((slot) => (
                <div key={slot.id} className="flex justify-between gap-3">
                  <span className="text-text-secondary">{dayNames[slot.dayOfWeek]}</span>
                  <span className="font-medium tabular-nums text-text-primary" dir="ltr">
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
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t("rosterTitle")}</CardTitle>
              <CardDescription>{t("rosterHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              {roster.length === 0 ? (
                <EmptyState compact icon={<Users />} title={t("rosterEmpty")} />
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {roster.map((student) => (
                    <li key={student.id} dir="auto" className="flex min-h-11 items-center text-sm text-text-primary">
                      {fullName(student)}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
