import { notFound } from "next/navigation";
import { IdCard, Printer, ShieldOff, Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { IdCardPanel } from "@/app/[locale]/(center)/students/[id]/id-card-panel";
import { PhotoForm } from "@/app/[locale]/(center)/students/[id]/photo-form";
import { StudentProfileForm } from "@/app/[locale]/(center)/students/[id]/student-profile-form";
import { VerifyParentLinkButton } from "@/app/[locale]/(center)/students/[id]/verify-parent-link-button";
import { deleteStudentAction } from "@/app/[locale]/(center)/students/actions";
import { DeleteRecordCard } from "@/components/center/delete-record-card";
import { IdCardPreview } from "@/components/center/id-card-preview";
import { ActionBar } from "@/components/shared/action-bar";
import { DetailCard, DetailLayout } from "@/components/shared/detail-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { DetailRow } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { PersonAvatar } from "@/components/shared/person-avatar";
import { Badge } from "@/components/ui/badge";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { countOtherCenterRelations } from "@/lib/db/identity";
import { studentCardSvg } from "@/lib/db/id-cards";
import { parentLinksForStudent } from "@/lib/db/parents";
import { scoped } from "@/lib/db/scoped";
import { idCardGeneratedAt, signedUrlFor } from "@/lib/db/storage";
import { formatDate, formatNumber } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone, todayInTimezone } from "@/lib/scheduling";
import { AVATARS_BUCKET } from "@/lib/storage-paths";
import { storageConfigured } from "@/lib/storage";

/**
 * One student at this center (spec §4.1 item 4): their record, their enrolment
 * view, their ID card, and who has blocked them.
 *
 * R10b layout (docs/04 §5 "Detail page"): a header with the student's photo
 * (or first letter), code, active state and grade, and the print actions as
 * one action bar; a main column of the record, enrolments (with the absence
 * streak alerts) and "blocked by"; a side column of the ID card, photo, parent
 * summary and parent links; and the danger zone set apart at the foot.
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

  const [grades, enrollments, blocks, otherRelations, cardStamp, parentLinks] =
    await Promise.all([
      db.grades.list(),
      db.enrollments.listForStudent(student.id),
      db.studentBlocks.list({ blockedUserId: student.userId }),
      countOtherCenterRelations(student.userId, ctx.center.id),
      hasStorage ? idCardGeneratedAt(ctx.center.id, student.id) : null,
      parentLinksForStudent(prisma, ctx.center.id, student.id),
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
        [
          enrollment.classGroup.subject ? catalogLabelWithSelection(locale, enrollment.classGroup.subject) : null,
          enrollment.classGroup.grade ? catalogLabelWithSelection(locale, enrollment.classGroup.grade) : null,
        ]
          .filter(Boolean)
          .join(" · ") || tCommon("none"),
      // SEC-62: the streak counts back no further than the visibility window.
      count: await db.attendees.absenceStreak(
        enrollment.classGroupId,
        student.id,
        // R7b: the centre's calendar day, so today's sessions count at 00:30 Cairo time.
        todayInTimezone(centreTimeZone(ctx.settings)),
      ),
    })),
  );
  const activeStreaks = absenceStreaks.filter((streak) => streak.count > 0);

  // `grades` comes from `scoped(ctx).grades.list()`, which already resolves
  // `.name` to this centre's own display-name override or the catalog
  // entry's bilingual name.
  // A grade the platform has deactivated is not offered — except the one this
  // student already has, which stays selectable so the record saves unchanged.
  const gradeOptions = grades
    .filter((grade) => grade.catalogActive || grade.id === student.gradeId)
    .map((grade) => ({
      value: grade.id,
      label:
        grade.active && grade.catalogActive ? grade.name : `${grade.name} · ${tCommon("inactive")}`,
    }));

  const personName = fullName(localName(student, student.user));
  // A short-lived signed URL (the same helper Reception uses), or null with no
  // photo on file / Storage unset — the avatar then shows the first letter.
  const photoUrl =
    hasStorage && student.photoUrl
      ? await signedUrlFor(ctx.center.id, AVATARS_BUCKET, student.photoUrl)
      : null;
  const gradeLabel = gradeOptions.find((option) => option.value === student.gradeId)?.label ?? null;
  const parentName = [student.parentFirstName, student.parentLastName].filter(Boolean).join(" ");
  const visibleEnrollments = enrollments.filter((e) => e.status !== "REMOVED");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={personName}
        description={t("detailSubtitle")}
        back={{ href: ROUTES.centerStudents, label: t("backToList") }}
        leading={<PersonAvatar name={personName} photoUrl={photoUrl} />}
        meta={
          <>
            <Badge variant="brand">
              <span dir="ltr">{student.studentCode}</span>
            </Badge>
            <Badge variant={student.active ? "success" : "neutral"}>
              {student.active ? tCommon("active") : tCommon("inactive")}
            </Badge>
            {gradeLabel ? <span>{gradeLabel}</span> : null}
          </>
        }
        action={
          <ActionBar inHeader>
            <LinkButton href={ROUTES.centerStudentCard(student.id)} className="w-full sm:w-auto">
              <IdCard className="size-4" aria-hidden />
              {t("card.printCard")}
            </LinkButton>
            <LinkButton href={ROUTES.centerStudentPaper(student.id)} className="w-full sm:w-auto">
              <Printer className="size-4" aria-hidden />
              {t("card.printPaper")}
            </LinkButton>
          </ActionBar>
        }
      />

      <DetailLayout
        main={
          <>
            <DetailCard title={t("profileTitle")} description={t("profileDescription")}>
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
              />
            </DetailCard>

            <DetailCard title={t("enrollments.title")} description={t("enrollments.description")}>
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
              {visibleEnrollments.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Users />}
                  title={t("enrollments.empty")}
                  description={t("enrollments.emptyHint")}
                />
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {visibleEnrollments.map((enrollment) => (
                    <li
                      key={enrollment.id}
                      className="flex flex-col gap-1 rounded-xl border border-border p-3"
                    >
                      <Link
                        href={ROUTES.centerClass(enrollment.classGroupId)}
                        className="text-sm font-medium text-brand hover:underline"
                      >
                        {enrollment.classGroup.subject ? catalogLabelWithSelection(locale, enrollment.classGroup.subject) : tCommon("none")}
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
            </DetailCard>

            <DetailCard title={t("blockedBy.title")} description={t("blockedBy.description")}>
              {blocks.length === 0 ? (
                <EmptyState
                  compact
                  icon={<ShieldOff />}
                  title={t("blockedBy.empty")}
                  description={t("blockedBy.emptyHint")}
                />
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
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
                              {[
                                classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
                                classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
                              ]
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
            </DetailCard>
          </>
        }
        side={
          <>
            <DetailCard title={t("card.title")} description={t("card.description")}>
              <IdCardPanel
                studentProfileId={student.id}
                generatedAt={cardStamp ? formatDate(cardStamp, locale) : null}
                storageEnabled={hasStorage}
              >
                <IdCardPreview svg={cardSvg} />
              </IdCardPanel>
            </DetailCard>

            <DetailCard title={t("photo.title")} description={t("photo.description")}>
              {hasStorage ? (
                <PhotoForm
                  studentProfileId={student.id}
                  hasPhoto={Boolean(student.photoUrl)}
                />
              ) : (
                <FormMessage tone="warning">{t("card.noStorage")}</FormMessage>
              )}
            </DetailCard>

            <DetailCard
              title={t("parentTitle")}
              description={t("parentDescription")}
              contentClassName="gap-0"
            >
              <DetailRow label={t("fields.parentName")} value={parentName} />
              <DetailRow label={t("fields.parentPhone")} value={student.parentPhone} ltr />
              <DetailRow label={t("fields.parentAltPhone")} value={student.parentAltPhone} ltr />
              <DetailRow label={t("fields.otherCenters")} value={formatNumber(otherRelations, locale)} />
            </DetailCard>

            <DetailCard title={t("parentLinks.title")} description={t("parentLinks.description")}>
              {parentLinks.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Users />}
                  title={t("parentLinks.empty")}
                  description={t("parentLinks.emptyHint")}
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {parentLinks.map((link) => (
                    <li
                      key={link.id}
                      className="flex flex-col gap-2 rounded-xl border border-border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {fullName(link.parentUser)}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                          <span dir="ltr">{link.matchedPhone}</span>
                          <span>{formatDate(link.createdAt, locale)}</span>
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            link.status === "VERIFIED"
                              ? "success"
                              : link.status === "REVOKED"
                                ? "danger"
                                : "warning"
                          }
                        >
                          {t(`parentLinks.status.${link.status}`)}
                        </Badge>
                        {link.status === "PENDING" && ctxCan(ctx, "parent.link.manage") ? (
                          <VerifyParentLinkButton parentLinkId={link.id} />
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </DetailCard>
          </>
        }
        below={
          ctxCan(ctx, "student.delete") ? (
            <DeleteRecordCard
              action={deleteStudentAction}
              idField="studentProfileId"
              recordId={student.id}
              title={t("danger.title")}
              description={t("danger.description")}
              confirmMessage={t("deleteConfirm")}
            />
          ) : null
        }
      />
    </div>
  );
}
