import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  AddSlotForm,
  ClassActiveControl,
  DeleteClassButton,
  RemoveSlotButton,
} from "@/components/teacher/workspaces/workspace-class-controls";
import { LinkedAssessments } from "@/app/[locale]/(teacher)/teacher/assessments/linked-assessments";
import { WorkspaceClassButton } from "@/components/teacher/workspaces/workspace-class-dialog";
import { NewWorkspaceSessionButton } from "@/components/teacher/workspaces/workspace-session-controls";
import { WorkspaceSessionList } from "@/components/teacher/workspaces/workspace-session-list";
import { LinkedBadge } from "@/components/teacher/workspaces/linked-badge";
import { EnrolStudentForm, RemoveEnrollmentButton } from "@/components/teacher/workspaces/workspace-student-controls";
import { workspaceCatalogPicker, workspaceClassLabel } from "@/components/teacher/workspaces/labels";
import { DetailRow } from "@/components/shared/field";
import { PageSection } from "@/components/shared/page-section";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getWorkspaceContext, workspaceOffersWrites } from "@/lib/auth/workspace-context";
import { listCatalogEducationSystems, listCatalogGrades, listCatalogSubjects } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { teacherPortalHistoryFloor } from "@/lib/db/teacher-portal";
import { workspaceClass, workspaceSessions } from "@/lib/db/workspaces";
import { workspaceClassRoster } from "@/lib/db/workspace-students";
import { fullName } from "@/lib/identity";
import { catalogLabel } from "@/lib/catalog";
import { formatDayRange, formatMoney, formatNumber, formatTimeRange } from "@/lib/format";
import { piastresToInputValue } from "@/lib/money";
import { centreTimeZone, dateKey, todayInTimezone } from "@/lib/scheduling";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Workspaces.classes");
  return { title: t("classTitle") };
}

/**
 * One workspace class (W8a, D-W38 item 7): its facts, Edit (period, price,
 * late threshold, catalogue), its weekly slots, deactivate / reactivate and
 * delete — each the class engine's own rule — and its sessions with the
 * session verbs. The class id is looked up inside this workspace only, so an
 * id from anywhere else is not-found.
 *
 * W8b (D-W39 item 11): its Students — the ACTIVE roster with Linked / Not
 * linked, Enrol (one of the workspace's own profiles; no approval, no seat
 * cap) and Remove, both offered only while the workspace takes writes.
 */
export default async function WorkspaceClassPage({ params }: { params: Promise<{ id: string; classId: string }> }) {
  const { id, classId } = await params;
  const ctx = await getWorkspaceContext(id);
  if (!ctx) notFound();
  const timeZone = centreTimeZone(ctx.settings);
  const today = todayInTimezone(timeZone);
  const row = await workspaceClass(prisma, ctx.center.id, classId, today);
  if (!row) notFound();

  const [t, tClasses, tFields, tSchedule, tCommon, tRoster, locale] = await Promise.all([
    getTranslations("Workspaces.classes"),
    getTranslations("Classes"),
    getTranslations("Classes.fields"),
    getTranslations("Classes.schedule"),
    getTranslations("Settings.common"),
    getTranslations("WorkspaceStudents.roster"),
    getLocale(),
  ]);
  const writable = workspaceOffersWrites(ctx);
  const [sessions, roster, systems, grades, subjects] = await Promise.all([
    workspaceSessions(prisma, ctx.center.id, { from: teacherPortalHistoryFloor(ctx), classId: row.id }),
    workspaceClassRoster(prisma, ctx.center.id, row.id),
    writable ? listCatalogEducationSystems(prisma, false) : Promise.resolve([]),
    writable ? listCatalogGrades(prisma, undefined, false) : Promise.resolve([]),
    writable ? listCatalogSubjects(prisma, undefined, false) : Promise.resolve([]),
  ]);
  const dayNames = tClasses.raw("dayNames") as string[];
  const catalog = workspaceCatalogPicker(
    locale,
    {
      systems: systems.filter((entry) => entry.active || entry.id === row.educationSystemId),
      grades: grades.filter((entry) => entry.active || entry.id === row.gradeId),
      subjects: subjects.filter((entry) => entry.active || entry.id === row.subjectId),
    },
    (name) => `${name} · ${tCommon("inactive")}`,
    row,
  );
  const label = workspaceClassLabel(locale, row, t("untitled"));

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-2">
              <h2 className="break-words text-lg font-semibold text-text-primary">{label}</h2>
              <Badge variant={row.active ? "success" : "neutral"} className="w-fit">
                {row.active ? t("active") : t("inactive")}
              </Badge>
            </div>
            {writable ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                <WorkspaceClassButton
                  workspaceId={ctx.center.id}
                  catalog={catalog}
                  noneLabel={tCommon("none")}
                  defaults={{
                    classId: row.id,
                    educationSystemId: row.educationSystemId ?? "",
                    gradeId: row.gradeId ?? "",
                    subjectId: row.subjectId ?? "",
                    price: piastresToInputValue(row.price),
                    lateThresholdMinutes: String(row.lateThresholdMinutes),
                    startDate: dateKey(row.startDate),
                    endDate: dateKey(row.endDate),
                  }}
                />
                <ClassActiveControl workspaceId={ctx.center.id} classId={row.id} active={row.active} />
                <DeleteClassButton workspaceId={ctx.center.id} classId={row.id} />
              </div>
            ) : null}
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            <DetailRow label={tFields("educationSystem")} value={row.educationSystem ? catalogLabel(locale, row.educationSystem) : tCommon("none")} />
            <DetailRow label={t("period")} value={formatDayRange(row.startDate, row.endDate, locale)} />
            <DetailRow label={tFields("price")} value={formatMoney(row.price, locale)} />
            <DetailRow label={tFields("lateThreshold")} value={formatNumber(row.lateThresholdMinutes, locale)} />
          </dl>
          <p className="text-xs text-text-secondary">{t("cutNote")}</p>
        </CardContent>
      </Card>

      <PageSection title={tSchedule("title")} description={t("slotsDescription")}>
        <div className="flex flex-col gap-4">
          {row.schedules.length === 0 ? (
            <p className="text-sm text-text-secondary">{tSchedule("empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {row.schedules.map((slot) => {
                const text = `${dayNames[slot.dayOfWeek] ?? ""} · ${formatTimeRange(slot.startTime, slot.endTime, locale)}`;
                return (
                  <li key={slot.id} className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border px-3">
                    <span className="text-sm text-text-primary">{text}</span>
                    {writable ? <RemoveSlotButton workspaceId={ctx.center.id} scheduleId={slot.id} label={tSchedule("remove")} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {writable ? <AddSlotForm workspaceId={ctx.center.id} classId={row.id} /> : null}
        </div>
      </PageSection>

      <PageSection title={tRoster("title")} description={tRoster("description", { count: roster.roster.length })}>
        <div className="flex flex-col gap-4">
          {roster.roster.length === 0 ? (
            <p className="text-sm text-text-secondary">{tRoster("empty")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {roster.roster.map(({ enrollmentId, student }) => (
                <li key={enrollmentId} className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                  <span className="min-w-0 break-words text-sm text-text-primary">{fullName(student)}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <LinkedBadge linked={student.linked} />
                    {writable ? (
                      <RemoveEnrollmentButton
                        workspaceId={ctx.center.id}
                        classId={row.id}
                        enrollmentId={enrollmentId}
                        studentName={fullName(student)}
                      />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {writable && row.active ? (
            <EnrolStudentForm
              workspaceId={ctx.center.id}
              classId={row.id}
              students={roster.enrollable.map((student) => ({ id: student.id, label: fullName(student) }))}
            />
          ) : null}
        </div>
      </PageSection>

      <PageSection
        title={t("sessionsTitle")}
        description={t("upcoming", { count: row._count.sessions })}
        action={
          writable && row.active ? (
            <NewWorkspaceSessionButton
              workspaceId={ctx.center.id}
              classes={[{ id: row.id, label }]}
              todayIso={dateKey(today)}
              defaultClassId={row.id}
            />
          ) : undefined
        }
      >
        <WorkspaceSessionList
          workspaceId={ctx.center.id}
          rows={sessions}
          timeZone={timeZone}
          todayIso={dateKey(today)}
          writable={writable}
        />
      </PageSection>

      {/* W9 (D-W42 item 7): the class's exams, as on a branch class page; none created while read-only. */}
      <LinkedAssessments ctx={ctx} kind="class" classGroupId={row.id} canCreate={writable && row.active} />
    </div>
  );
}
