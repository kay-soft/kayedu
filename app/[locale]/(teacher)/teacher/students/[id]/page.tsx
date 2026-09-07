import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { StudentBlockForm } from "@/app/[locale]/(teacher)/teacher/students/[id]/block-form";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTenantContext } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { sessionDisplayName } from "@/lib/db/sessions";
import { studentSessionsWithTeacher } from "@/lib/db/teacher-portal";
import { formatDate, formatMoney } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

const ATTENDANCE_BADGE = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "danger",
  EXCUSED: "info",
} as const;

/**
 * A student's history **with this teacher only** (spec §4.2 item 3) — never
 * the student's full cross-teacher record, which would leak other teachers'
 * sessions. Access itself is scoped the same way: a student profile id this
 * teacher has never had an attendance record with 404s here, exactly like a
 * foreign center's id would.
 */
export default async function TeacherStudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getTenantContext("teacher");
  const { id } = await params;

  const db = scoped(ctx);
  const student = await db.students.findDetailById(id);
  if (!student) notFound();

  const sessions = await studentSessionsWithTeacher(prisma, ctx.center.id, ctx.user.id, id);
  if (sessions.length === 0) notFound();

  const t = await getTranslations("TeacherStudents");
  const tAttendance = await getTranslations("Sessions.attendance");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const blocks = await db.studentBlocks.list({
    scope: "TEACHER",
    refId: ctx.user.id,
    blockedUserId: student.userId,
  });
  const activeBlock = blocks[0]
    ? { id: blocks[0].id, reason: blocks[0].reason }
    : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={fullName(localName(student, student.user))}
        description={t("detailSubtitle")}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-text-muted" dir="ltr">
              {student.studentCode}
            </span>
            <Link
              href={ROUTES.teacherStudents}
              className="inline-flex h-11 items-center rounded-lg border border-border px-4 text-sm text-text-secondary hover:bg-surface-subtle"
            >
              {t("backToList")}
            </Link>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <Card>
          <CardHeader>
            <CardTitle>{t("sessionsTitle")}</CardTitle>
            <CardDescription>{t("sessionsDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {sessions.map((attendee) => (
                <li
                  key={attendee.id}
                  className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <Link
                      href={ROUTES.teacherSession(attendee.session.id)}
                      className="truncate text-sm font-medium text-brand hover:underline"
                    >
                      {sessionDisplayName(locale, attendee.session)}
                    </Link>
                    <p className="mt-1 text-xs text-text-muted">
                      {formatDate(attendee.session.date, locale)}
                      {attendee.payments[0]
                        ? ` · ${formatMoney(attendee.payments[0].amount, locale)}`
                        : ""}
                    </p>
                  </div>
                  <Badge variant={ATTENDANCE_BADGE[attendee.attendanceStatus]}>
                    {tAttendance(attendee.attendanceStatus)}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("fields.grade")}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-text-primary">
              {student.grade ? catalogLabelWithSelection(locale, student.grade) : tCommon("none")}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("block.title")}</CardTitle>
              <CardDescription>{t("block.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <StudentBlockForm studentProfileId={student.id} block={activeBlock} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
