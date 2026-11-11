import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { assistantAssessmentBranches, withinAssistantFloor, type AssistantAssessmentBranch } from "@/app/[locale]/(assistant)/assistant/[teacherId]/assessments/scope";
import { AssessmentBuilder } from "@/app/[locale]/(teacher)/teacher/assessments/builder";
import { newPayload } from "@/app/[locale]/(teacher)/teacher/assessments/initial";
import { EmptyState } from "@/components/shared/empty-state";
import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getAssistantScope } from "@/lib/auth/assistant-context";
import { findOwnClassForExam, findOwnSessionForHomework, homeworkDeadlineFor, sessionZone } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { workspaceClasses } from "@/lib/db/workspaces";
import { formatDate, formatTimeRange } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES, assessmentRoutes, type AssessmentSurface } from "@/lib/routes";
import { dateKey, todayInTimezone } from "@/lib/scheduling";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * A new exam or homework for the teacher, by their assistant (W7b, D-W37 item
 * 3): the teacher's builder, `assessments.manage` only. Nothing is written until
 * the first "Save draft". The class or session must be **the teacher's own** at a
 * branch `assistantCan` grants (the W2 finders on the teacher's membership), and
 * a homework's session must be inside the assistant's window.
 *
 * - `?type=HOMEWORK&session=…` — from the assistant's class page.
 * - `?type=EXAM&class=…` — from the class page or this step.
 * - `?type=EXAM` alone — first choose one of the teacher's active classes.
 *
 * W9 (D-W42 item 9): the teacher's PERSONAL workspaces where `assistantCan`
 * grants `assessments.manage` are places too — named and tagged Private; an
 * archived one offers no class and shows why.
 */
export default async function AssistantNewAssessmentPage({
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
  const type = query.type === "HOMEWORK" ? "HOMEWORK" : "EXAM";
  const surface: AssessmentSurface = { kind: "assistant", teacherId };
  const routes = assessmentRoutes(surface);

  const branches = await assistantAssessmentBranches(scope, "assessments.manage");
  if (branches.length === 0) notFound();
  const t = await getTranslations("TeacherAssessments");
  const locale = await getLocale();
  const several = scope.branches.length > 1;
  // A workspace is always named: it is never one of the teacher's branches.
  const placeName = (entry: AssistantAssessmentBranch) => (several || entry.isPrivate ? entry.branch.centerName : null);
  const readOnlyNotice = (entry: AssistantAssessmentBranch) =>
    entry.readOnly ? <FormMessage tone="warning">{t(`errors.${entry.readOnly}`)}</FormMessage> : null;
  const back = { href: routes.list, label: t("builder.back") };
  const now = new Date();

  if (type === "HOMEWORK") {
    if (!query.session) notFound();
    let hit: { entry: (typeof branches)[number]; session: NonNullable<Awaited<ReturnType<typeof findOwnSessionForHomework>>> } | null = null;
    for (const entry of branches) {
      const session = await findOwnSessionForHomework(prisma, entry.teacher, query.session!);
      if (session && withinAssistantFloor(entry, session.date)) {
        hit = { entry, session };
        break;
      }
    }
    if (!hit) notFound();
    const { entry, session } = hit!;
    const zone = sessionZone(session, entry.zone);
    const { deadline, basis } = await homeworkDeadlineFor(prisma, entry.branch.centerId, { ...session, classGroupId: session.classGroupId! }, entry.zone);
    const label = sessionDisplayName(locale, { classGroup: session.classGroup });
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t("builder.newHomeworkTitle")}
          description={[label, `${formatDate(session.date, locale)} · ${formatTimeRange(session.startTime, session.endTime, locale)}`, placeName(entry)]
            .filter(Boolean)
            .join(" · ")}
          back={
            entry.isPrivate
              ? { href: ROUTES.assistantWorkspaceSession(teacherId, entry.branch.centerId, session.id), label: t("builder.backToSession") }
              : session.classGroupId
                ? { href: ROUTES.assistantClass(teacherId, session.classGroupId), label: t("builder.back") }
                : back
          }
        />
        {readOnlyNotice(entry) ?? (
          <AssessmentBuilder
            mode="create"
            centerId={entry.branch.centerId}
            type="HOMEWORK"
            sessionId={session.id}
            zone={zone}
            nowMs={now.getTime()}
            todayIso={dateKey(todayInTimezone(zone, now))}
            deadlineBasis={basis}
            initial={newPayload("HOMEWORK", deadline, zone)}
            surface={surface}
          />
        )}
      </div>
    );
  }

  if (query.class) {
    let hit: { entry: (typeof branches)[number]; classGroup: NonNullable<Awaited<ReturnType<typeof findOwnClassForExam>>> } | null = null;
    for (const entry of branches) {
      const classGroup = await findOwnClassForExam(prisma, entry.teacher, query.class!);
      if (classGroup) {
        hit = { entry, classGroup };
        break;
      }
    }
    if (!hit) notFound();
    const { entry, classGroup } = hit!;
    const label = sessionDisplayName(locale, { classGroup });
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t("builder.newExamTitle")} description={placeName(entry) ? `${label} · ${placeName(entry)}` : label} back={back} />
        {readOnlyNotice(entry) ?? (
          <AssessmentBuilder
            mode="create"
            centerId={entry.branch.centerId}
            type="EXAM"
            classGroupId={classGroup.id}
            zone={entry.zone}
            nowMs={now.getTime()}
            todayIso={dateKey(todayInTimezone(entry.zone, now))}
            initial={newPayload("EXAM", null, entry.zone)}
            surface={surface}
          />
        )}
      </div>
    );
  }

  // Choose the class first — the teacher's own active classes at each branch that allows it.
  // W9: a workspace's active classes (the teacher teaches every one there); none from an archived one.
  const perBranch = await Promise.all(
    branches
      .filter((entry) => entry.readOnly === null)
      .map(async (entry) => ({
        entry,
        classes: entry.ctx
          ? await scoped(entry.ctx).classGroups.list({ teacherId, active: true })
          : (await workspaceClasses(prisma, entry.branch.centerId, todayInTimezone(entry.zone, now))).filter((row) => row.active),
      })),
  );
  const choices = perBranch.flatMap(({ entry, classes }) => classes.map((classGroup) => ({ entry, classGroup })));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("pickClass.title")} description={t("pickClass.description")} back={back} />
      <Card>
        <CardContent>
          {choices.length === 0 ? (
            <EmptyState icon={<BookOpen />} title={t("pickClass.empty")} />
          ) : (
            <ul className="flex flex-col gap-3">
              {choices.map(({ entry, classGroup }) => (
                <li key={classGroup.id}>
                  <Link
                    href={`${routes.newBase}?type=EXAM&class=${encodeURIComponent(classGroup.id)}`}
                    className="flex min-h-11 flex-col gap-1 rounded-xl border border-border p-4 transition-ui hover:border-border-strong hover:shadow-card-hover"
                  >
                    <span className="text-sm font-semibold text-text-primary">{sessionDisplayName(locale, { classGroup })}</span>
                    {placeName(entry) ? (
                      <span className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                        <span dir="auto">{placeName(entry)}</span>
                        {entry.isPrivate ? <Badge variant="neutral">{t("privateTag")}</Badge> : null}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
