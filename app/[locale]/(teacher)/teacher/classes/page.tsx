import { getLocale, getTranslations } from "next-intl/server";
import { BookOpen } from "lucide-react";

import { ClassRequestForm } from "@/app/[locale]/(teacher)/teacher/classes/class-request-form";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatTimeRange } from "@/lib/format";
import { EmptyState } from "@/components/shared/empty-state";

const STATUS_BADGE = {
  PENDING: "warning",
  APPROVED: "success",
  DECLINED: "danger",
} as const;

type RequestPayload = {
  subjectId?: string | null;
  gradeId?: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  capacity: number;
  lateThresholdMinutes: number;
  note?: string | null;
};

/**
 * "Request a new class at a center where they're a trusted teacher" (spec
 * §4.2 item 4). Writes a `ChangeRequest` and lists the teacher's own — a
 * center manager reviews it at `/approvals`. The form is hidden (and the
 * action refuses) when this center has not marked the teacher trusted
 * (M10, `Membership.isTrustedTeacher`).
 */
export default async function TeacherClassesPage() {
  const ctx = await getTenantContext("teacher");
  await requirePermission(ctx, "changeRequest.create");
  const db = scoped(ctx);

  const t = await getTranslations("TeacherClasses");
  const tDays = await getTranslations("Classes");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const [subjects, grades, requests] = await Promise.all([
    db.subjects.list({ active: true }),
    db.grades.list({ active: true }),
    db.changeRequests.list({ requestedBy: ctx.user.id, type: "NEW_CLASS" }),
  ]);

  const subjectOptions = subjects.map((subject) => ({ value: subject.id, label: subject.name }));
  const gradeOptions = grades.map((grade) => ({ value: grade.id, label: grade.name }));
  const dayNames = tDays.raw("dayNames") as string[];

  const canRequest =
    ctxCan(ctx, "changeRequest.create") && (ctx.membership?.isTrustedTeacher ?? false);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { center: ctx.center.name })} />

      {canRequest ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("request.title")}</CardTitle>
            <CardDescription>{t("request.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ClassRequestForm subjects={subjectOptions} grades={gradeOptions} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {requests.length === 0 ? (
            <EmptyState icon={<BookOpen />} title={t("empty")} description={t("emptyHint")} />
          ) : (
            <ul className="flex flex-col gap-2">
              {requests.map((request) => {
                const payload = request.payload as unknown as RequestPayload;
                const subject = subjectOptions.find((s) => s.value === payload.subjectId);
                const grade = gradeOptions.find((g) => g.value === payload.gradeId);
                return (
                  <li
                    key={request.id}
                    className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary">
                        {[subject?.label, grade?.label].filter(Boolean).join(" · ") ||
                          tCommon("none")}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                        <span>{dayNames[payload.dayOfWeek]}</span>
                        <span>{formatTimeRange(payload.startTime, payload.endTime, locale)}</span>
                        <span>{formatDate(request.createdAt, locale)}</span>
                      </p>
                    </div>
                    <Badge variant={STATUS_BADGE[request.status]}>
                      {t(`status.${request.status}`)}
                    </Badge>
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
