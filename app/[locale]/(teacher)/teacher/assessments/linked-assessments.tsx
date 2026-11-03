import { FileQuestion, Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { AssessmentList } from "@/components/teacher/assessment-list";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TenantContext } from "@/lib/auth/tenant";
import { listTeacherAssessments, resolveAssessmentTeacher } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone } from "@/lib/scheduling";

/**
 * A class page's or a session page's own exams and homework (W2), with its
 * create button: "New exam" on a class, "Add homework" on a session. Renders
 * nothing where this branch does not let the teacher manage assessments
 * (`resolveAssessmentTeacher` — the Owner's switch, an active TEACHER
 * membership). A one-time session says why it takes no homework (D-W03).
 */
export async function LinkedAssessments(
  props: { ctx: TenantContext } & (
    | { kind: "class"; classGroupId: string; canCreate: boolean }
    | { kind: "session"; sessionId: string; hasClass: boolean; canCreate: boolean }
  ),
) {
  const teacher = await resolveAssessmentTeacher(prisma, props.ctx);
  if (!teacher) return null;
  const t = await getTranslations("TeacherAssessments");
  const section = props.kind === "class" ? "classSection" : "sessionSection";

  const rows =
    props.kind === "class"
      ? await listTeacherAssessments(prisma, teacher, { classGroupId: props.classGroupId })
      : await listTeacherAssessments(prisma, teacher, { sessionId: props.sessionId });
  const branch = `branch=${encodeURIComponent(props.ctx.center.id)}`;
  const createHref =
    props.kind === "class"
      ? `${ROUTES.teacherAssessmentNew}?type=EXAM&${branch}&class=${encodeURIComponent(props.classGroupId)}`
      : `${ROUTES.teacherAssessmentNew}?type=HOMEWORK&${branch}&session=${encodeURIComponent(props.sessionId)}`;
  const oneOff = props.kind === "session" && !props.hasClass;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`${section}.title`)}</CardTitle>
        {oneOff ? <CardDescription>{t("sessionSection.oneOff")}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <EmptyState compact icon={<FileQuestion />} title={t(`${section}.empty`)} />
        ) : (
          <AssessmentList
            entries={rows.map((row) => ({ row, branchName: props.ctx.center.name, branchZone: centreTimeZone(props.ctx.settings) }))}
            showBranch={false}
            showClass={props.kind === "session"}
          />
        )}
        {props.canCreate && !oneOff ? (
          <LinkButton href={createHref} className="self-start">
            <Plus className="size-4" aria-hidden />
            {props.kind === "class" ? t("newExam") : t("addHomework")}
          </LinkButton>
        ) : null}
      </CardContent>
    </Card>
  );
}
