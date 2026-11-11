import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { ClassRequestForm } from "@/app/[locale]/(teacher)/teacher/classes/class-request-form";
import { SessionRequestForm } from "@/app/[locale]/(teacher)/teacher/sessions/session-request-form";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAssistantScope, scopeBranches } from "@/lib/auth/assistant-context";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { buildCatalogPicker } from "@/lib/catalog-picker";
import { listTeacherRequestsAt } from "@/lib/db/assistant-requests";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatDay, formatTimeRange } from "@/lib/format";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Assistants.work.requests");
  return { title: t("title") };
}

const STATUS_BADGE = { PENDING: "warning", APPROVED: "success", DECLINED: "danger" } as const;

type Payload = {
  classGroupId?: string;
  date?: string;
  subjectId?: string | null;
  gradeId?: string | null;
  dayOfWeek?: number;
  startTime: string;
  endTime: string;
};

/**
 * Requests for the teacher, by their assistant (W7b, D-W37 item 5; docs/04
 * §11.36) — `requests.manage`, only at branches where the teacher may request
 * (their `changeRequest.create` cell and trusted flag) and that allow
 * assistants: the teacher's own "Request new session" and "Request a new
 * class" forms, filed as the teacher's, then every request of the teacher's
 * there with its status, within the assistant's window. Approving and
 * declining are the centre's; cancelling a request is not built (backlog).
 */
export default async function AssistantRequestsPage({ params }: { params: Promise<{ teacherId: string }> }) {
  const { teacherId } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const branches = scopeBranches(scope, "requests.manage");
  if (branches.length === 0) notFound();

  const t = await getTranslations("Assistants.work.requests");
  const tClasses = await getTranslations("TeacherClasses");
  const tSessions = await getTranslations("TeacherSessions");
  const tCommon = await getTranslations("Settings.common");
  const tDays = await getTranslations("Classes");
  const locale = await getLocale();
  const dayNames = tDays.raw("dayNames") as string[];
  const several = branches.length > 1;

  const perBranch = await Promise.all(
    branches.map(async (branch) => {
      const db = scoped(branch.ctx);
      const [systems, subjects, grades, classes, requests] = await Promise.all([
        db.educationSystems.list(),
        db.subjects.list(),
        db.grades.list(),
        db.classGroups.list({ teacherId, active: true }),
        listTeacherRequestsAt(prisma, { centerId: branch.centerId, teacherUserId: teacherId, floor: branch.floor }),
      ]);
      return {
        branch,
        catalog: buildCatalogPicker({ systems, grades, subjects }, (name) => `${name} · ${tCommon("inactive")}`),
        subjectNameById: new Map(subjects.map((subject) => [subject.id, subject.name])),
        gradeNameById: new Map(grades.map((grade) => [grade.id, grade.name])),
        classes: classes.map((classGroup) => ({
          value: classGroup.id,
          label:
            [
              classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
              classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
            ]
              .filter(Boolean)
              .join(" · ") || tCommon("none"),
        })),
        requests,
      };
    }),
  );
  const classLabelById = new Map(perBranch.flatMap((entry) => entry.classes.map((option) => [option.value, option.label] as const)));
  const requests = perBranch
    .flatMap((entry) => entry.requests.map((request) => ({ request, entry })))
    .sort((a, b) => b.request.createdAt.getTime() - a.request.createdAt.getTime());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { teacher: scope.link.teacherName })} />

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Card>
          <CardHeader>
            <CardTitle as="h2">{tSessions("request.title")}</CardTitle>
            <CardDescription>{tSessions("request.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <SessionRequestForm
              teacherId={teacherId}
              branches={perBranch.map((entry) => ({ id: entry.branch.centerId, name: entry.branch.centerName, classes: entry.classes }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h2">{tClasses("request.title")}</CardTitle>
            <CardDescription>{tClasses("request.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ClassRequestForm
              teacherId={teacherId}
              branches={perBranch.map((entry) => ({ id: entry.branch.centerId, name: entry.branch.centerName, catalog: entry.catalog }))}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("listTitle")}</CardTitle>
          <CardDescription>{t("listHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <EmptyState icon={<ClipboardList />} title={t("empty")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {requests.map(({ request, entry }) => {
                const payload = request.payload as unknown as Payload;
                const headline =
                  request.type === "NEW_SESSION"
                    ? (payload.classGroupId ? classLabelById.get(payload.classGroupId) : undefined) ?? tCommon("none")
                    : [
                        payload.subjectId ? entry.subjectNameById.get(payload.subjectId) : undefined,
                        payload.gradeId ? entry.gradeNameById.get(payload.gradeId) : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ") || tCommon("none");
                const when =
                  request.type === "NEW_SESSION" && payload.date
                    ? formatDay(new Date(`${payload.date}T00:00:00.000Z`), locale)
                    : payload.dayOfWeek !== undefined
                      ? dayNames[payload.dayOfWeek]
                      : null;
                return (
                  <li
                    key={request.id}
                    className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                        <span>{headline}</span>
                        <Badge variant="neutral">{t(`type.${request.type}`)}</Badge>
                        {request.viaAssistant ? <Badge variant="neutral">{t("viaAssistant")}</Badge> : null}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                        {several ? <span className="font-medium text-text-secondary">{entry.branch.centerName}</span> : null}
                        {when ? <span>{when}</span> : null}
                        <span dir="ltr">{formatTimeRange(payload.startTime, payload.endTime, locale)}</span>
                        <span>{t("filedOn", { date: formatDate(request.createdAt, locale) })}</span>
                      </p>
                    </div>
                    <Badge variant={STATUS_BADGE[request.status]}>{tClasses(`status.${request.status}`)}</Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
