import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { weeklySlotsLine, workspaceClassLabel } from "@/components/teacher/workspaces/labels";
import { WorkspaceSessionList } from "@/components/teacher/workspaces/workspace-session-list";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { Ltr } from "@/components/shared/ltr";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAssistantScope, scopeCan, scopeWorkspace } from "@/lib/auth/assistant-context";
import { assistantWorkspaceClassRoster } from "@/lib/db/assistant-workspaces";
import { prisma } from "@/lib/db/client";
import { workspaceClass, workspaceSessions } from "@/lib/db/workspaces";
import { formatDayRange, formatMoney } from "@/lib/format";
import { fullName } from "@/lib/identity";
import { formatPhone } from "@/lib/phone";
import { ROUTES, assessmentRoutes } from "@/lib/routes";
import { dateKey, todayInTimezone } from "@/lib/scheduling";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.work.workspaces");
  return { title: t("classTitle") };
}

/**
 * One workspace class, read-only, for an assistant with `classes.view` there
 * (W8d, D-W41 item 9): its schedule, its sessions from the assistant's floor
 * (the teacher's `teacherHistoryDays`, D-W19) — each opening the session page
 * — and the roster's names, with phones only under `students.phones`.
 * Found only inside a workspace the scope holds; another workspace's class id
 * is a 404. No edit, enrol or remove.
 */
export default async function AssistantWorkspaceClassPage({
  params,
}: {
  params: Promise<{ teacherId: string; id: string; classId: string }>;
}) {
  const { teacherId, id, classId } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const workspace = scopeWorkspace(scope, id);
  if (!workspace || !scopeCan(scope, "classes.view", workspace.centerId)) notFound();
  const today = todayInTimezone(workspace.zone);
  const row = await workspaceClass(prisma, workspace.centerId, classId, today);
  if (!row) notFound();

  const withPhones = scopeCan(scope, "students.phones", workspace.centerId);
  const [t, tClasses, locale, sessions, roster] = await Promise.all([
    getTranslations("Assistants.work.workspaces"),
    getTranslations("Classes"),
    getLocale(),
    workspaceSessions(prisma, workspace.centerId, { from: workspace.floor, classId: row.id }),
    assistantWorkspaceClassRoster(prisma, workspace.centerId, row.id, { withPhones }),
  ]);
  const dayNames = tClasses.raw("dayNames") as string[];
  // W9 (D-W42 item 9): a new exam on this class, with `assessments.manage` here, on an active class of a live workspace.
  const canNewExam = row.active && workspace.archivedAt === null && scopeCan(scope, "assessments.manage", workspace.centerId);
  const tAssessments = await getTranslations("TeacherAssessments");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={workspaceClassLabel(locale, row, t("untitledClass"))}
        description={workspace.centerName}
        back={{ href: ROUTES.assistantWorkspace(teacherId, workspace.centerId), label: t("classesTitle") }}
        meta={row.active ? <Badge variant="neutral">{t("private")}</Badge> : <Badge variant="neutral">{t("inactive")}</Badge>}
        action={
          canNewExam ? (
            <LinkButton href={`${assessmentRoutes({ kind: "assistant", teacherId }).newBase}?type=EXAM&class=${encodeURIComponent(row.id)}`}>
              {tAssessments("newExam")}
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
            <WorkspaceSessionList
              workspaceId={workspace.centerId}
              rows={sessions}
              timeZone={workspace.zone}
              todayIso={dateKey(today)}
              writable={false}
              sessionHref={(sessionId) => ROUTES.assistantWorkspaceSession(teacherId, workspace.centerId, sessionId)}
            />
          </CardContent>
        </Card>
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t("schedule")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <p className="text-text-primary">{weeklySlotsLine(locale, dayNames, row.schedules)}</p>
              <p className="text-text-secondary">
                {formatDayRange(row.startDate, row.endDate, locale)} · {formatMoney(row.price, locale)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle as="h2">{t("rosterTitle")}</CardTitle>
              <CardDescription>{withPhones ? t("rosterHintPhones") : t("rosterHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              {roster.length === 0 ? (
                <EmptyState compact icon={<Users />} title={t("rosterEmpty")} />
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {roster.map((student) => (
                    <li key={student.studentProfileId} className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 py-2 text-sm">
                      <span dir="auto" className="text-text-primary">{fullName(student)}</span>
                      {student.phone ? (
                        <span className="text-xs text-text-secondary">
                          <Ltr>{formatPhone(student.phone)}</Ltr>
                        </span>
                      ) : null}
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
