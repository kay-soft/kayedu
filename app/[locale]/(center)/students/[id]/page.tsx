import { notFound } from "next/navigation";
import { IdCard, Printer, ShieldOff, Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { IdCardPanel } from "@/app/[locale]/(center)/students/[id]/id-card-panel";
import { AccountGradeMismatch } from "@/app/[locale]/(center)/students/[id]/account-grade-mismatch";
import { PhotoForm } from "@/app/[locale]/(center)/students/[id]/photo-form";
import { StudentProfileForm } from "@/app/[locale]/(center)/students/[id]/student-profile-form";
import {
  CancelParentCodeButton,
  GenerateParentCodeButton,
  RevokeParentLinkButton,
} from "@/app/[locale]/(center)/students/[id]/parent-access";
import { deleteStudentAction } from "@/app/[locale]/(center)/students/actions";
import { DeleteRecordCard } from "@/components/center/delete-record-card";
import { IdCardPreview } from "@/components/center/id-card-preview";
import { ActionBar } from "@/components/shared/action-bar";
import { DetailCard, DetailLayout } from "@/components/shared/detail-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { DetailRow } from "@/components/shared/field";
import type { SlipTexts } from "@/components/family/parent-code-slip";
import { Ltr } from "@/components/shared/ltr";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { PersonAvatar } from "@/components/shared/person-avatar";
import { Badge } from "@/components/ui/badge";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import { catalogGradeById } from "@/lib/db/account-study";
import { prisma } from "@/lib/db/client";
import { countOtherCenterRelations } from "@/lib/db/identity";
import { studentCardSvg } from "@/lib/db/id-cards";
import { FAMILY_LIMITS, familyAccessForStudent, type BranchFamilyAccess } from "@/lib/db/parents";
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
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "student.manage");

  const { id } = await params;
  const db = scoped(ctx);
  const student = await db.students.findDetailById(id);
  if (!student) notFound();

  const locale = await getLocale();
  const t = await getTranslations("Students");
  const tCommon = await getTranslations("Settings.common");
  const tTeachers = await getTranslations("Teachers");
  const tFamily = await getTranslations("Family.branch");

  const hasStorage = storageConfigured();

  // Everything that needs only the student row goes out together — the card,
  // the photo URL and the lists — rather than one stage after another
  // (docs/08 §4.6.2).
  const [grades, enrollments, blocks, otherRelations, cardStamp, familyAccess, cardSvg, photoUrl, slipAr, slipEn] =
    await Promise.all([
      db.grades.list(),
      db.enrollments.listForStudent(student.id),
      db.studentBlocks.list({ blockedUserId: student.userId }),
      countOtherCenterRelations(student.userId, ctx.center.id),
      hasStorage ? idCardGeneratedAt(ctx.center.id, student.id) : null,
      familyAccessForStudent(prisma, ctx.center.id, student.id),
      studentCardSvg(ctx, student, {
        dir: locale === "ar" ? "rtl" : "ltr",
        codeLabel: t("card.codeLabel"),
      }),
      // A short-lived signed URL (the same helper Reception uses), or null with
      // no photo on file / Storage unset — the avatar then shows the first letter.
      hasStorage && student.photoUrl
        ? signedUrlFor(ctx.center.id, AVATARS_BUCKET, student.photoUrl)
        : null,
      // F3: the printable parent-code slip is bilingual whatever the page's language.
      getTranslations({ locale: "ar", namespace: "Family.slip" }),
      getTranslations({ locale: "en", namespace: "Family.slip" }),
    ]);

  // A TEACHER block names the teacher by their User id; a CLASS block names
  // the class by its ClassGroup id — both resolved inside this center.
  const teacherRefIds = blocks
    .filter((block) => block.scope === "TEACHER")
    .map((block) => block.refId);
  const classRefIds = blocks
    .filter((block) => block.scope === "CLASS")
    .map((block) => block.refId);
  // Consecutive-absence per active enrollment (spec §7 acceptance criterion
  // 13, closing the gap flagged at M5 — the session receipt already showed
  // this; the student profile did not). `consecutiveAbsenceCount` is
  // class-scoped, so a student enrolled in two classes gets two independent
  // streaks, not one blended count. It reads the enrollments, not the blocks,
  // so it shares a stage with the block lookups.
  const activeEnrollments = enrollments.filter((e) => e.status === "ACTIVE");
  const [blockingTeachers, blockingClasses, absenceStreaks] = await Promise.all([
    teacherRefIds.length > 0
      ? db.teachers.list({ userId: { in: teacherRefIds } })
      : Promise.resolve([]),
    classRefIds.length > 0
      ? db.classGroups.list({ id: { in: classRefIds } })
      : Promise.resolve([]),
    Promise.all(
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
    ),
  ]);
  const teacherByUserId = new Map(
    blockingTeachers.map((teacher) => [teacher.userId, teacher]),
  );
  const classById = new Map(
    blockingClasses.map((classGroup) => [classGroup.id, classGroup]),
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

  // F4: the student's own account grade, when it names a different grade from
  // the one this branch has on file. This branch's rename when it offers that
  // grade; the catalog name when it does not (then it cannot be adopted here).
  const accountGradeId = student.user.gradeId;
  const accountDiffers = Boolean(accountGradeId && accountGradeId !== student.gradeId);
  const offeredAccountGrade = accountDiffers ? grades.find((grade) => grade.id === accountGradeId) : undefined;
  const accountGradeName = offeredAccountGrade?.name ?? null;
  const globalAccountGrade =
    accountDiffers && !offeredAccountGrade && accountGradeId ? await catalogGradeById(prisma, accountGradeId) : null;
  const accountGradeLabel = accountGradeName ?? (globalAccountGrade ? catalogLabel(locale, globalAccountGrade) : null);

  const personName = fullName(localName(student, student.user));
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
            {accountDiffers && accountGradeLabel ? (
              <AccountGradeMismatch
                studentProfileId={student.id}
                accountGrade={accountGradeLabel}
                canAdopt={Boolean(offeredAccountGrade && offeredAccountGrade.catalogActive)}
              />
            ) : null}
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

            <DetailCard title={tFamily("title")} description={tFamily("description")}>
              <ParentAccessCard
                access={familyAccess}
                canManage={ctxCan(ctx, "parent.link.manage")}
                studentProfileId={student.id}
                locale={locale}
                slip={{
                  branchName: ctx.center.name,
                  studentName: personName,
                  ar: slipTexts(slipAr),
                  en: slipTexts(slipEn),
                }}
              />
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

type SlipTranslator = Awaited<ReturnType<typeof getTranslations<"Family.slip">>>;

function slipTexts(tSlip: SlipTranslator): SlipTexts {
  return {
    title: tSlip("title"),
    branch: tSlip("branch"),
    student: tSlip("student"),
    code: tSlip("code"),
    link: tSlip("link"),
    handOver: tSlip("handOver"),
    steps: tSlip("steps"),
  };
}

/**
 * "Parent access" (F3, docs/04 §11.22): every ACTIVE parent account of this
 * student — account name, how they were linked, the date, and the parent the
 * student declared when there is one, so a mismatch stands out. No parent
 * email or phone is shown. Generating, cancelling and revoking need
 * `parent.link.manage`; every action re-checks it on the server.
 */
async function ParentAccessCard({
  access,
  canManage,
  studentProfileId,
  locale,
  slip,
}: {
  access: BranchFamilyAccess | null;
  canManage: boolean;
  studentProfileId: string;
  locale: string;
  slip: { branchName: string; studentName: string; ar: SlipTexts; en: SlipTexts };
}) {
  const t = await getTranslations("Family.branch");
  if (!access) return null;
  const slotsFull = access.slotsUsed >= FAMILY_LIMITS.slotsPerStudent;
  // Replacing this branch's own waiting code frees its slot first.
  const blocked = slotsFull && !access.pendingCode;

  return (
    <div className="flex flex-col gap-4">
      {access.links.length === 0 ? (
        <EmptyState compact icon={<Users />} title={t("empty")} description={t("emptyHint")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {access.links.map((link) => {
            const parentName = fullName({ firstName: link.parentFirstName, lastName: link.parentLastName });
            return (
              <li key={link.id} className="flex flex-col gap-3 rounded-xl border border-border p-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm font-medium break-words text-text-primary">{parentName}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                    <Badge variant="neutral">{t(`origin.${link.origin}`)}</Badge>
                    <span>{t("since", { date: formatDate(link.since, locale) })}</span>
                  </div>
                  {link.declaredParentName ? (
                    <p className="text-xs break-words text-text-secondary">
                      {t("declared", { name: link.declaredParentName })}
                    </p>
                  ) : null}
                </div>
                {canManage ? (
                  <RevokeParentLinkButton studentProfileId={studentProfileId} linkId={link.id} parentName={parentName} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-text-secondary">
        {t("slots", { used: access.slotsUsed, max: FAMILY_LIMITS.slotsPerStudent })}
      </p>

      {access.pendingCode ? (
        <FormMessage tone="info">
          {t.rich("pending", {
            hint: access.pendingCode.hint,
            date: formatDate(access.pendingCode.createdAt, locale),
            code: (chunks) => <Ltr className="font-mono">{chunks}</Ltr>,
          })}
        </FormMessage>
      ) : null}

      {canManage ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
          <GenerateParentCodeButton
            studentProfileId={studentProfileId}
            replacing={Boolean(access.pendingCode)}
            disabled={blocked}
            disabledReason={t("slotsFullHint")}
            slip={slip}
          />
          {access.pendingCode ? <CancelParentCodeButton studentProfileId={studentProfileId} /> : null}
        </div>
      ) : (
        <p className="text-xs text-text-muted">{t("noPermission")}</p>
      )}
    </div>
  );
}
