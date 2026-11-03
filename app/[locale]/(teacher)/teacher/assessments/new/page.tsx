import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { AssessmentBuilder } from "@/app/[locale]/(teacher)/teacher/assessments/builder";
import { newPayload } from "@/app/[locale]/(teacher)/teacher/assessments/initial";
import { assessmentBranches } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/tenant";
import { findInBranches, firstGranting, getTeacherScope } from "@/lib/auth/teacher-scope";
import {
  findOwnClassForExam,
  findOwnSessionForHomework,
  homeworkDeadlineFor,
  sessionZone,
} from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatTimeRange } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { dateKey, todayInTimezone } from "@/lib/scheduling";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * A new exam or homework (W2). Nothing is written until the first "Save
 * draft" (the builder's action creates it and lands on its edit page), so an
 * abandoned "New exam" leaves no empty row.
 *
 * - `?type=HOMEWORK&session=…` — from a session page: the session must be the
 *   teacher's own class session (D-W03); the deadline is pre-filled.
 * - `?type=EXAM&class=…` — from a class page or this step: the teacher's own
 *   active class.
 * - `?type=EXAM` alone — first choose the class (every branch in view that
 *   grants `assessment.manage.own`).
 */
export default async function NewAssessmentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await getTeacherScope();
  const ctx = firstGranting(scope, "assessment.manage.own");
  await requirePermission(ctx, "assessment.manage.own");
  const params = await searchParams;
  const type = params.type === "HOMEWORK" ? "HOMEWORK" : "EXAM";

  const t = await getTranslations("TeacherAssessments");
  const locale = await getLocale();
  const branches = await assessmentBranches(scope.inView);
  const teacherAt = (centerId: string) => branches.find((branch) => branch.ctx.center.id === centerId)!;
  // The named branch is asked first; the row is still found only where it really lives.
  const ordered = [
    ...branches.filter((branch) => branch.ctx.center.id === params.branch),
    ...branches.filter((branch) => branch.ctx.center.id !== params.branch),
  ];
  const several = scope.inView.length > 1;
  const back = { href: ROUTES.teacherAssessments, label: t("builder.back") };
  const now = new Date();

  if (type === "HOMEWORK") {
    if (!params.session) notFound();
    const hit = await findInBranches(
      ordered.map((branch) => branch.ctx),
      (branchCtx) => findOwnSessionForHomework(prisma, teacherAt(branchCtx.center.id).teacher, params.session!),
    );
    if (!hit) notFound();
    const branch = teacherAt(hit!.ctx.center.id);
    const session = hit!.found;
    const zone = sessionZone(session, branch.zone);
    const { deadline, basis } = await homeworkDeadlineFor(prisma, branch.ctx.center.id, { ...session, classGroupId: session.classGroupId! }, branch.zone);
    const label = sessionDisplayName(locale, { classGroup: session.classGroup });
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t("builder.newHomeworkTitle")}
          description={[label, `${formatDate(session.date, locale)} · ${formatTimeRange(session.startTime, session.endTime, locale)}`, several ? branch.ctx.center.name : null]
            .filter(Boolean)
            .join(" · ")}
          back={{ href: ROUTES.teacherSession(session.id), label: t("builder.backToSession") }}
        />
        <AssessmentBuilder
          mode="create"
          centerId={branch.ctx.center.id}
          type="HOMEWORK"
          sessionId={session.id}
          zone={zone}
          nowMs={now.getTime()}
          todayIso={dateKey(todayInTimezone(zone, now))}
          deadlineBasis={basis}
          initial={newPayload("HOMEWORK", deadline, zone)}
        />
      </div>
    );
  }

  if (params.class) {
    const hit = await findInBranches(
      ordered.map((branch) => branch.ctx),
      (branchCtx) => findOwnClassForExam(prisma, teacherAt(branchCtx.center.id).teacher, params.class!),
    );
    if (!hit) notFound();
    const branch = teacherAt(hit!.ctx.center.id);
    const label = sessionDisplayName(locale, { classGroup: hit!.found });
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t("builder.newExamTitle")}
          description={several ? `${label} · ${branch.ctx.center.name}` : label}
          back={back}
        />
        <AssessmentBuilder
          mode="create"
          centerId={branch.ctx.center.id}
          type="EXAM"
          classGroupId={hit!.found.id}
          zone={branch.zone}
          nowMs={now.getTime()}
          todayIso={dateKey(todayInTimezone(branch.zone, now))}
          initial={newPayload("EXAM", null, branch.zone)}
        />
      </div>
    );
  }

  // Choose the class first — the teacher's own active classes at each granting branch.
  const perBranch = await Promise.all(
    branches.map(async (branch) => ({
      branch,
      classes: await scoped(branch.ctx).classGroups.list({ teacherId: branch.ctx.user.id, active: true }),
    })),
  );
  const choices = perBranch.flatMap(({ branch, classes }) => classes.map((classGroup) => ({ branch, classGroup })));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("pickClass.title")} description={t("pickClass.description")} back={back} />
      <Card>
        <CardContent>
          {choices.length === 0 ? (
            <EmptyState icon={<BookOpen />} title={t("pickClass.empty")} />
          ) : (
            <ul className="flex flex-col gap-3">
              {choices.map(({ branch, classGroup }) => (
                <li key={classGroup.id}>
                  <Link
                    href={`${ROUTES.teacherAssessmentNew}?type=EXAM&branch=${encodeURIComponent(branch.ctx.center.id)}&class=${encodeURIComponent(classGroup.id)}`}
                    className="flex min-h-11 flex-col gap-1 rounded-xl border border-border p-4 transition-ui hover:border-border-strong hover:shadow-card-hover"
                  >
                    <span className="text-sm font-semibold text-text-primary">{sessionDisplayName(locale, { classGroup })}</span>
                    {several ? <span className="text-xs text-text-muted">{branch.ctx.center.name}</span> : null}
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
