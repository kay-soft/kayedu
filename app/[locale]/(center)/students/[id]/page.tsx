import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { IdCardPanel } from "@/app/[locale]/(center)/students/[id]/id-card-panel";
import { PhotoForm } from "@/app/[locale]/(center)/students/[id]/photo-form";
import { StudentProfileForm } from "@/app/[locale]/(center)/students/[id]/student-profile-form";
import { IdCardPreview } from "@/components/center/id-card-preview";
import { DetailRow } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
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
import { consecutiveAbsenceCount } from "@/lib/db/attendance";
import { prisma } from "@/lib/db/client";
import { countOtherCenterRelations } from "@/lib/db/identity";
import { studentCardSvg } from "@/lib/db/id-cards";
import { scoped } from "@/lib/db/scoped";
import { idCardGeneratedAt } from "@/lib/db/storage";
import { formatDate } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { storageConfigured } from "@/lib/supabase/admin";

/**
 * One student at this center (spec §4.1 item 4): their record, their enrolment
 * view, their ID card, and who has blocked them.
 *
 * The id in the URL is resolved through the scoped helper, so a student id
 * from another center resolves to "not found", never to a row (docs/02 §5).
 */
export default async function StudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "student.manage");

  const { id } = await params;
  const db = scoped(ctx);
  const student = await db.students.findDetailById(id);
  if (!student) notFound();

  const locale = await getLocale();
  const t = await getTranslations("Students");
  const tCommon = await getTranslations("Settings.common");
  const tTeachers = await getTranslations("Teachers");

  const hasStorage = storageConfigured();

  const [grades, enrollments, blocks, otherRelations, cardStamp] =
    await Promise.all([
      db.grades.list(),
      db.enrollments.listForStudent(student.id),
      db.studentBlocks.list({ blockedUserId: student.userId }),
      countOtherCenterRelations(student.userId, ctx.center.id),
      hasStorage ? idCardGeneratedAt(ctx.center.id, student.id) : null,
    ]);

  // A TEACHER block names the teacher by their User id; a CLASS block names
  // the class by its ClassGroup id — both resolved inside this center.
  const teacherRefIds = blocks
    .filter((block) => block.scope === "TEACHER")
    .map((block) => block.refId);
  const classRefIds = blocks
    .filter((block) => block.scope === "CLASS")
    .map((block) => block.refId);
  const [blockingTeachers, blockingClasses] = await Promise.all([
    teacherRefIds.length > 0
      ? db.teachers.list({ userId: { in: teacherRefIds } })
      : Promise.resolve([]),
    classRefIds.length > 0
      ? db.classGroups.list({ id: { in: classRefIds } })
      : Promise.resolve([]),
  ]);
  const teacherByUserId = new Map(
    blockingTeachers.map((teacher) => [teacher.userId, teacher]),
  );
  const classById = new Map(
    blockingClasses.map((classGroup) => [classGroup.id, classGroup]),
  );

  const cardSvg = await studentCardSvg(ctx, student, {
    dir: locale === "ar" ? "rtl" : "ltr",
    codeLabel: t("card.codeLabel"),
  });

  // Consecutive-absence per active enrollment (spec §7 acceptance criterion
  // 13, closing the gap flagged at M5 — the session receipt already showed
  // this; the student profile did not). `consecutiveAbsenceCount` is
  // class-scoped, so a student enrolled in two classes gets two independent
  // streaks, not one blended count.
  const activeEnrollments = enrollments.filter((e) => e.status === "ACTIVE");
  const absenceStreaks = await Promise.all(
    activeEnrollments.map(async (enrollment) => ({
      classGroupId: enrollment.classGroupId,
      className:
        [enrollment.classGroup.subject?.name, enrollment.classGroup.grade?.name]
          .filter(Boolean)
          .join(" · ") || tCommon("none"),
      count: await consecutiveAbsenceCount(
        prisma,
        ctx.center.id,
        enrollment.classGroupId,
        student.id,
        new Date(),
      ),
    })),
  );
  const activeStreaks = absenceStreaks.filter((streak) => streak.count > 0);

  const gradeOptions = grades.map((grade) => ({
    value: grade.id,
    label: grade.active ? grade.name : `${grade.name} · ${tCommon("inactive")}`,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={fullName(localName(student, student.user))}
        description={t("detailSubtitle")}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="brand">{student.studentCode}</Badge>
            <Badge variant={student.active ? "success" : "neutral"}>
              {student.active ? tCommon("active") : tCommon("inactive")}
            </Badge>
            <Link
              href={ROUTES.centerStudents}
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
            <CardTitle>{t("profileTitle")}</CardTitle>
            <CardDescription>{t("profileDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <StudentProfileForm
              studentProfileId={student.id}
              name={localName(student, student.user)}
              contact={{
                email: student.email ?? "",
                phone: student.phone ?? "",
                altPhone: student.altPhone ?? "",
              }}
              student={{
                gradeId: student.gradeId ?? "",
                studentCode: student.studentCode,
                parentFirstName: student.parentFirstName ?? "",
                parentLastName: student.parentLastName ?? "",
                parentPhone: student.parentPhone ?? "",
                parentAltPhone: student.parentAltPhone ?? "",
              }}
              grades={gradeOptions}
              noneLabel={tCommon("none")}
              canDelete={ctxCan(ctx, "student.delete")}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("card.title")}</CardTitle>
              <CardDescription>{t("card.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <IdCardPanel
                studentProfileId={student.id}
                generatedAt={cardStamp ? formatDate(cardStamp, locale) : null}
                storageEnabled={hasStorage}
              >
                <IdCardPreview svg={cardSvg} />
              </IdCardPanel>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("photo.title")}</CardTitle>
              <CardDescription>{t("photo.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              {hasStorage ? (
                <PhotoForm
                  studentProfileId={student.id}
                  hasPhoto={Boolean(student.photoUrl)}
                />
              ) : (
                <FormMessage tone="warning">{t("card.noStorage")}</FormMessage>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("parentTitle")}</CardTitle>
              <CardDescription>{t("parentDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <DetailRow
                label={t("fields.parentName")}
                value={[student.parentFirstName, student.parentLastName]
                  .filter(Boolean)
                  .join(" ")}
              />
              <DetailRow
                label={t("fields.parentPhone")}
                value={student.parentPhone}
                ltr
              />
              <DetailRow
                label={t("fields.parentAltPhone")}
                value={student.parentAltPhone}
                ltr
              />
              <DetailRow
                label={t("fields.otherCenters")}
                value={String(otherRelations)}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Card>
          <CardHeader>
            <CardTitle>{t("enrollments.title")}</CardTitle>
            <CardDescription>{t("enrollments.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {activeStreaks.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {activeStreaks.map((streak) => (
                  <li key={streak.classGroupId}>
                    <FormMessage tone="warning">
                      {t("enrollments.consecutiveAbsentAlert", {
                        className: streak.className,
                        count: streak.count,
                      })}
                    </FormMessage>
                  </li>
                ))}
              </ul>
            ) : null}
            {enrollments.filter((e) => e.status !== "REMOVED").length === 0 ? (
              <FormMessage tone="info">{t("enrollments.empty")}</FormMessage>
            ) : (
              <ul className="flex flex-col gap-2">
                {enrollments
                  .filter((enrollment) => enrollment.status !== "REMOVED")
                  .map((enrollment) => (
                    <li
                      key={enrollment.id}
                      className="flex flex-col gap-1 rounded-xl border border-border p-3"
                    >
                      <Link
                        href={ROUTES.centerClass(enrollment.classGroupId)}
                        className="text-sm font-medium text-brand hover:underline"
                      >
                        {enrollment.classGroup.subject?.name ?? tCommon("none")}
                      </Link>
                      <span className="text-xs text-text-muted">
                        {fullName(enrollment.classGroup.teacher)}
                        {enrollment.status === "BLOCKED"
                          ? ` · ${t("enrollments.blocked")}`
                          : ""}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("blockedBy.title")}</CardTitle>
            <CardDescription>{t("blockedBy.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            {blocks.length === 0 ? (
              <p className="text-sm text-text-muted">{t("blockedBy.empty")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {blocks.map((block) => {
                  const teacher =
                    block.scope === "TEACHER"
                      ? teacherByUserId.get(block.refId)
                      : undefined;
                  const classGroup =
                    block.scope === "CLASS" ? classById.get(block.refId) : undefined;
                  return (
                    <li
                      key={block.id}
                      className="flex flex-col gap-1 rounded-xl border border-border p-3"
                    >
                      <span className="text-sm font-medium text-text-primary">
                        {block.scope === "TEACHER" ? (
                          teacher ? (
                            <Link
                              href={ROUTES.centerTeacher(teacher.id)}
                              className="text-brand hover:underline"
                            >
                              {fullName(localName(teacher, teacher.user))}
                            </Link>
                          ) : (
                            tTeachers("blocks.unknownTeacher")
                          )
                        ) : classGroup ? (
                          <Link
                            href={ROUTES.centerClass(classGroup.id)}
                            className="text-brand hover:underline"
                          >
                            {[classGroup.subject?.name, classGroup.grade?.name]
                              .filter(Boolean)
                              .join(" · ")}
                          </Link>
                        ) : (
                          t("blockedBy.unknownClass")
                        )}
                      </span>
                      {block.reason ? (
                        <span className="text-xs text-text-muted">
                          {block.reason}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
