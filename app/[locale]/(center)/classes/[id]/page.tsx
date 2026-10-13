import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { EditClassDialog } from "@/app/[locale]/(center)/classes/[id]/class-profile-form";
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
import { classSessionCounts, keptClassSessions } from "@/lib/db/class-sessions";
import { prisma } from "@/lib/db/client";
import { classRoomSetFrom } from "@/lib/db/room-sets";
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { formatDay, formatDayRange, formatMoney, formatNumber, formatTimeRange } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { piastresToInputValue } from "@/lib/money";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { dateKey } from "@/lib/scheduling";
import { LinkButton } from "@/components/shared/link-button";
import { Link } from "@/lib/i18n/navigation";

const MAX_CANDIDATES = 8;

/**
 * One class at this center (spec §4.1 item 3): its config, its period and
 * weekly schedule (docs/04 §9 "Class Schedule Builder"), its sessions, and
 * its roster. R4: the "Sessions" card shows the period, how many sessions it
 * has, and any upcoming session kept after an edit because it already
 * carries records or custom changes — there is no generator to run.
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
    roomLinks,
    enrollments,
    classBlocks,
    terms,
    sessionCounts,
    kept,
  ] = await Promise.all([
    db.teachers.list({ active: true }),
    db.subjects.list(),
    db.grades.list(),
    db.educationSystems.list(),
    db.rooms.list(),
    db.roomLinks.list(),
    db.enrollments.listForClass(id),
    db.studentBlocks.list({ scope: "CLASS", refId: id }),
    db.terms.listActive(),
    classSessionCounts(prisma, ctx.center.id, [id]),
    keptClassSessions(prisma, ctx.center.id, id),
  ]);
  const sessionCount = sessionCounts.get(id) ?? 0;

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

  // R3 — the class's room set and the seats it adds up to (its enrolment cap).
  const roomSet = classRoomSetFrom(classGroup);

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
    phone: row.phone,
  }));
  // A class whose teacher has since been deactivated still shows them as
  // chosen (and can be saved unchanged) instead of an empty picker.
  if (teacher && !teacherOptions.some((option) => option.value === classGroup.teacherId)) {
    teacherOptions.push({
      value: classGroup.teacherId,
      label: `${fullName(localName(teacher, teacher.user))} · ${tCommon("inactive")}`,
      phone: teacher.phone,
    });
  }

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
            <EditClassDialog
              classGroupId={classGroup.id}
              values={{
                teacherId: classGroup.teacherId,
                subjectId: classGroup.subjectId ?? "",
                gradeId: classGroup.gradeId ?? "",
                educationSystemId: classGroup.educationSystemId ?? "",
                roomId: classGroup.roomId ?? "",
                extraRoomIds: classGroup.roomId
                  ? classGroup.extraRooms.map((extra) => extra.roomId)
                  : [],
                price: piastresToInputValue(classGroup.price),
                centerShareType: classGroup.centerShareType,
                centerShareValue:
                  classGroup.centerShareType === "FIXED"
                    ? piastresToInputValue(classGroup.centerShareValue)
                    : String(classGroup.centerShareValue),
                lateThresholdMinutes: String(classGroup.lateThresholdMinutes),
                acceptsNewStudents: classGroup.acceptsNewStudents,
                requiresConfirmation: classGroup.requiresConfirmation,
                startDate: dateKey(classGroup.startDate),
                endDate: dateKey(classGroup.endDate),
              }}
              teachers={teacherOptions}
              subjects={optionList(subjects)}
              grades={optionList(grades)}
              educationSystems={optionList(educationSystems)}
              educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
              rooms={rooms.map((room) => ({
                id: room.id,
                name: room.name,
                capacity: room.capacity,
                active: room.active,
              }))}
              roomLinks={roomLinks}
              terms={terms.map((term) => ({
                id: term.id,
                name: term.name,
                startDate: dateKey(term.startDate),
                endDate: dateKey(term.endDate),
              }))}
              noneLabel={tCommon("none")}
              canDelete={ctxCan(ctx, "class.delete")}
              active={classGroup.active}
            />
            <Badge variant={classGroup.active ? "success" : "neutral"}>
              {classGroup.active ? tCommon("active") : tCommon("inactive")}
            </Badge>
            <LinkButton href={ROUTES.centerClasses}>
              {t("backToList")}
            </LinkButton>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
        <div className="contents">
          <Card>
            <CardHeader>
              <CardTitle>{t("context.title")}</CardTitle>
              <CardDescription>{t("context.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.room")}</span>
                <span className="text-end font-medium text-text-primary">
                  {roomSet.rooms.map((room) => room.name).join(" + ") || tCommon("none")}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.seats")}</span>
                <span className="font-medium tabular-nums text-text-primary">
                  {roomSet.capacity > 0
                    ? t("fields.seatsValue", {
                        enrolled: roster.length,
                        seats: roomSet.capacity,
                      })
                    : t("fields.seatsUnlimited", { enrolled: roster.length })}
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
              <CardTitle>{t("sessions.title")}</CardTitle>
              <CardDescription>{t("sessions.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("period.title")}</span>
                <span className="text-end font-medium text-text-primary">
                  {formatDayRange(classGroup.startDate, classGroup.endDate, locale)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("sessions.count")}</span>
                <span className="font-medium tabular-nums text-text-primary">
                  {formatNumber(sessionCount, locale)}
                </span>
              </div>
              {!classGroup.active ? (
                <p className="text-xs text-text-muted">{t("sessions.inactiveHint")}</p>
              ) : null}
              {kept.length > 0 ? (
                <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning-bg p-3 text-warning" role="status">
                  <p className="font-medium">{t("sessionsSync.kept", { count: kept.length })}</p>
                  <ul className="flex flex-col gap-1 ps-5 text-text-primary">
                    {kept.slice(0, 10).map((session) => (
                      <li key={session.sessionId} className="list-disc">
                        <Link href={ROUTES.centerSession(session.sessionId)} className="hover:underline">
                          {formatDay(new Date(`${session.date}T00:00:00.000Z`), locale)} ·{" "}
                          {formatTimeRange(session.startTime, session.endTime, locale)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {kept.length > 10 ? (
                    <p className="text-xs">{t("sessions.keptMore", { count: kept.length - 10 })}</p>
                  ) : null}
                  <p className="text-xs text-text-secondary">{t("sessions.keptHint")}</p>
                </div>
              ) : null}
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
