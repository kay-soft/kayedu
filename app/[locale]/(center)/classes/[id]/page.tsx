import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { ClassProfileForm } from "@/app/[locale]/(center)/classes/[id]/class-profile-form";
import {
  ClassRoster,
  type BlockedRow,
  type EnrollCandidate,
  type RosterRow,
} from "@/app/[locale]/(center)/classes/[id]/class-roster";
import {
  ScheduleBuilder,
  type ScheduleSlotRow,
} from "@/app/[locale]/(center)/classes/[id]/schedule-builder";
import { GenerateSessionsButton } from "@/app/[locale]/(center)/classes/generate-sessions-button";
import { searchEnrollCandidatesAction } from "@/app/[locale]/(center)/classes/actions";
import { TypeAheadSearch } from "@/components/center/type-ahead-search";
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
import { studentSearchWhere } from "@/lib/db/students";
import { formatMoney } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { piastresToInputValue } from "@/lib/money";
import { catalogLabelWithSelection } from "@/lib/catalog";

const MAX_CANDIDATES = 8;

/**
 * One class at this center (spec §4.1 item 3): its config, its weekly
 * schedule (docs/04 §9 "Class Schedule Builder"), and its roster.
 *
 * The id in the URL is resolved through the scoped helper, so a class id
 * from another center resolves to "not found", never to a row (docs/02 §5).
 */
export default async function ClassDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "class.manage");

  const locale = await getLocale();
  const { id } = await params;
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  const db = scoped(ctx);
  const classGroup = await db.classGroups.findDetailById(id);
  if (!classGroup) notFound();

  const t = await getTranslations("Classes");
  const tCommon = await getTranslations("Settings.common");

  const teacher = await db.teachers.findByUserId(classGroup.teacherId);

  const [
    teachers,
    subjects,
    grades,
    educationSystems,
    rooms,
    enrollments,
    classBlocks,
  ] = await Promise.all([
    db.teachers.list({ active: true }),
    db.subjects.list(),
    db.grades.list(),
    db.educationSystems.list(),
    db.rooms.list(),
    db.enrollments.listForClass(id),
    db.studentBlocks.list({ scope: "CLASS", refId: id }),
  ]);

  const roster: RosterRow[] = enrollments
    .filter((enrollment) => enrollment.status === "ACTIVE")
    .map((enrollment) => ({
      enrollmentId: enrollment.id,
      studentProfileId: enrollment.studentProfileId,
      name: fullName(
        localName(enrollment.studentProfile, enrollment.studentProfile.user),
      ),
      studentCode: enrollment.studentProfile.studentCode,
    }));

  const excludedStudentIds = new Set(
    enrollments
      .filter((enrollment) => enrollment.status !== "REMOVED")
      .map((enrollment) => enrollment.studentProfileId),
  );

  const blockedUserIds = classBlocks.map((block) => block.blockedUserId);
  const blockedProfiles =
    blockedUserIds.length > 0
      ? await db.students.list({ userId: { in: blockedUserIds } })
      : [];
  const profileByUserId = new Map(
    blockedProfiles.map((profile) => [profile.userId, profile]),
  );

  const blocked: BlockedRow[] = classBlocks.map((block) => {
    const profile = profileByUserId.get(block.blockedUserId);
    return {
      blockId: block.id,
      studentProfileId: profile?.id ?? null,
      name: profile
        ? fullName(localName(profile, profile.user))
        : t("roster.unknownStudent"),
      studentCode: profile?.studentCode ?? null,
      reason: block.reason,
    };
  });

  const candidates: EnrollCandidate[] =
    query.length > 0
      ? (
          await db.students.search({
            where: {
              ...studentSearchWhere(query),
              active: true,
              ...(excludedStudentIds.size > 0
                ? { NOT: { id: { in: [...excludedStudentIds] } } }
                : {}),
            },
            take: MAX_CANDIDATES,
          })
        ).map((profile) => ({
          studentProfileId: profile.id,
          name: fullName(localName(profile, profile.user)),
          studentCode: profile.studentCode,
        }))
      : [];

  const schedules: ScheduleSlotRow[] = classGroup.schedules.map((schedule) => ({
    id: schedule.id,
    dayOfWeek: schedule.dayOfWeek,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
  }));

  const optionList = (
    rows: { id: string; name: string; active: boolean }[],
  ) =>
    rows.map((row) => ({
      value: row.id,
      label: row.active ? row.name : `${row.name} · ${tCommon("inactive")}`,
    }));

  const teacherOptions = teachers.map((row) => ({
    value: row.userId,
    label: fullName(localName(row, row.user)),
  }));

  const subjectGrade = [
    classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
    classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const educationSystemDefaultFixedShare = Object.fromEntries(
    educationSystems.map((system) => [system.id, system.defaultFixedCenterShare]),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={subjectGrade || t("columns.untitled")}
        description={teacher ? fullName(localName(teacher, teacher.user)) : tCommon("none")}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={classGroup.active ? "success" : "neutral"}>
              {classGroup.active ? tCommon("active") : tCommon("inactive")}
            </Badge>
            <Link
              href={ROUTES.centerClasses}
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
            <ClassProfileForm
              classGroupId={classGroup.id}
              values={{
                teacherId: classGroup.teacherId,
                subjectId: classGroup.subjectId ?? "",
                gradeId: classGroup.gradeId ?? "",
                educationSystemId: classGroup.educationSystemId ?? "",
                roomId: classGroup.roomId ?? "",
                price: piastresToInputValue(classGroup.price),
                centerShareType: classGroup.centerShareType,
                centerShareValue:
                  classGroup.centerShareType === "FIXED"
                    ? piastresToInputValue(classGroup.centerShareValue)
                    : String(classGroup.centerShareValue),
                capacity: String(classGroup.capacity),
                attendanceRequired: classGroup.attendanceRequired,
                lateThresholdMinutes: String(classGroup.lateThresholdMinutes),
                acceptsNewStudents: classGroup.acceptsNewStudents,
                requiresConfirmation: classGroup.requiresConfirmation,
                allowExcused: classGroup.allowExcused,
              }}
              teachers={teacherOptions}
              subjects={optionList(subjects)}
              grades={optionList(grades)}
              educationSystems={optionList(educationSystems)}
              educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
              rooms={optionList(rooms)}
              noneLabel={tCommon("none")}
              canDelete={ctxCan(ctx, "class.delete")}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("context.title")}</CardTitle>
              <CardDescription>{t("context.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.room")}</span>
                <span className="font-medium text-text-primary">
                  {classGroup.room?.name ?? tCommon("none")}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.price")}</span>
                <span className="font-medium tabular-nums text-text-primary">
                  {formatMoney(classGroup.price, ctx.user.locale)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("schedule.title")}</CardTitle>
              <CardDescription>{t("schedule.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ScheduleBuilder classGroupId={classGroup.id} slots={schedules} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("generate.title")}</CardTitle>
              <CardDescription>{t("generate.classDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <GenerateSessionsButton classGroupId={classGroup.id} />
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("roster.title")}</CardTitle>
          <CardDescription>{t("roster.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TypeAheadSearch
            value={query}
            label={t("roster.searchLabel")}
            placeholder={t("roster.searchPlaceholder")}
            submitLabel={t("roster.searchSubmit")}
            search={searchEnrollCandidatesAction.bind(null, classGroup.id)}
          />
          <ClassRoster
            classGroupId={classGroup.id}
            roster={roster}
            blocked={blocked}
            candidates={candidates}
            query={query}
          />
        </CardContent>
      </Card>
    </div>
  );
}
