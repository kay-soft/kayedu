import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { AssessmentBuilder } from "@/app/[locale]/(teacher)/teacher/assessments/builder";
import { DeleteAssessment } from "@/app/[locale]/(teacher)/teacher/assessments/delete-assessment";
import { payloadFromRow } from "@/app/[locale]/(teacher)/teacher/assessments/initial";
import { assessmentBranches } from "@/app/[locale]/(teacher)/teacher/assessments/scope";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/tenant";
import { findInBranches, firstGranting, getTeacherScope } from "@/lib/auth/teacher-scope";
import { findTeacherAssessment, sessionZone } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { formatDate, formatTimeRange } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { dateKey, todayInTimezone } from "@/lib/scheduling";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * Edit a draft (W2, docs/04 §11.33). Found at the branch that holds it among
 * those where the teacher may manage assessments, and only when the teacher's
 * own membership owns it — another teacher's, or another branch's, is a 404.
 */
export default async function EditAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const scope = await getTeacherScope();
  const ctx = firstGranting(scope, "assessment.manage.own");
  await requirePermission(ctx, "assessment.manage.own");
  const { id } = await params;

  const branches = await assessmentBranches(scope.inView);
  const hit = await findInBranches(
    branches.map((branch) => branch.ctx),
    (branchCtx) => findTeacherAssessment(prisma, branches.find((b) => b.ctx === branchCtx)!.teacher, id),
  );
  if (!hit) notFound();
  const branch = branches.find((b) => b.ctx === hit!.ctx)!;
  const row = hit!.found;
  const zone = row.session ? sessionZone(row.session, branch.zone) : branch.zone;

  const t = await getTranslations("TeacherAssessments");
  const locale = await getLocale();
  const now = new Date();
  const label = sessionDisplayName(locale, { classGroup: row.classGroup });
  const sessionLine = row.session
    ? `${formatDate(row.session.date, locale)} · ${formatTimeRange(row.session.startTime, row.session.endTime, locale)}`
    : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t(row.type === "EXAM" ? "builder.editExamTitle" : "builder.editHomeworkTitle")}
        description={[label, sessionLine, scope.inView.length > 1 ? branch.ctx.center.name : null].filter(Boolean).join(" · ")}
        back={{ href: ROUTES.teacherAssessments, label: t("builder.back") }}
        meta={
          <div className="flex flex-wrap gap-2">
            <Badge variant="neutral">{t(`type.${row.type}`)}</Badge>
            <Badge variant={row.status === "PUBLISHED" ? "info" : "neutral"}>{t(`status.${row.status}`)}</Badge>
          </div>
        }
      />
      <AssessmentBuilder
        mode="edit"
        centerId={branch.ctx.center.id}
        assessmentId={row.id}
        type={row.type}
        zone={zone}
        nowMs={now.getTime()}
        todayIso={dateKey(todayInTimezone(zone, now))}
        initial={payloadFromRow(row, zone)}
      />
      {row.status === "DRAFT" ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("builder.delete.sectionTitle")}</CardTitle>
            <CardDescription>{t("builder.delete.sectionHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteAssessment centerId={branch.ctx.center.id} assessmentId={row.id} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
