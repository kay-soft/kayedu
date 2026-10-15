import { notFound } from "next/navigation";
import { CalendarRange, DoorOpen } from "lucide-react";
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
import { ActionBar } from "@/components/shared/action-bar";
import { DetailCard, DetailLayout } from "@/components/shared/detail-layout";
import { DetailRow } from "@/components/shared/field";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
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
import { Link } from "@/lib/i18n/navigation";

const MAX_CANDIDATES = 8;

/**
 * One class at this center (spec §4.1 item 3): its config, its period and
 * weekly schedule (docs/04 §9 "Class Schedule Builder"), its sessions, and
 * its roster. R4: the "Sessions" card shows the period, how many sessions it
 * has, and any upcoming session kept after an edit because it already
 * carries records or custom changes — there is no generator to run.
 *
 * R10b layout (docs/04 §5 "Detail page"): a header with the class name,
 * teacher, rooms, period and active state and **Edit class** as its action bar;
 * the kept-sessions warning, when there is one, directly under it; a main
 * column of the weekly schedule and the roster; a side column of the key facts
 * and the sessions summary, which stays in view beside a long roster.
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

  // A picker never offers an entry the platform has deactivated — except the
  // one this class already has, which stays selectable (and labelled) so the
  // class can be saved unchanged.
  const optionList = (
    rows: { id: string; name: string; active: boolean; catalogActive: boolean }[],
    currentId: string | null,
  ) =>
    rows
      .filter((row) => row.catalogActive || row.id === currentId)
      .map((row) => ({
        value: row.id,
        label:
          row.active && row.catalogActive ? row.name : `${row.name} · ${tCommon("inactive")}`,
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

  const roomNames = roomSet.rooms.map((room) => room.name).join(" + ");
  const showCut = ctxCan(ctx, "center.profit.view");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={subjectGrade || t("columns.untitled")}
        description={teacher ? fullName(localName(teacher, teacher.user)) : tCommon("none")}
        back={{ href: ROUTES.centerClasses, label: t("backToList") }}
        meta={
          <>
            <Badge variant={classGroup.active ? "success" : "neutral"}>
              {classGroup.active ? tCommon("active") : tCommon("inactive")}
            </Badge>
            <span className="inline-flex items-center gap-1.5">
              <CalendarRange className="size-4 text-text-muted" aria-hidden />
              {formatDayRange(classGroup.startDate, classGroup.endDate, locale)}
            </span>
            {roomNames ? (
              <span className="inline-flex items-center gap-1.5">
                <DoorOpen className="size-4 text-text-muted" aria-hidden />
                {roomNames}
              </span>
            ) : null}
          </>
        }
        action={
          <ActionBar inHeader>
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
              subjects={optionList(subjects, classGroup.subjectId)}
              grades={optionList(grades, classGroup.gradeId)}
              educationSystems={optionList(educationSystems, classGroup.educationSystemId)}
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
          </ActionBar>
        }
      />

      {kept.length > 0 ? (
        <div
          className="flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning-bg p-4 text-sm text-warning-fg"
          role="status"
        >
          <p className="font-medium">{t("sessionsSync.kept", { count: kept.length })}</p>
          <ul className="grid gap-x-6 gap-y-1 ps-5 text-text-primary sm:grid-cols-2">
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

      <DetailLayout
        stickySide
        main={
          <>
            <DetailCard title={t("schedule.title")} description={t("schedule.description")}>
              <ScheduleBuilder classGroupId={classGroup.id} slots={schedules} />
            </DetailCard>

            <DetailCard title={t("roster.title")} description={t("roster.description")}>
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
            </DetailCard>
          </>
        }
        side={
          <>
            <DetailCard
              title={t("context.title")}
              description={t("context.description")}
              contentClassName="gap-0"
            >
              <DetailRow label={t("fields.room")} value={roomNames || tCommon("none")} />
              <DetailRow
                label={t("fields.seats")}
                value={
                  roomSet.capacity > 0
                    ? t("fields.seatsValue", {
                        enrolled: formatNumber(roster.length, locale),
                        seats: formatNumber(roomSet.capacity, locale),
                      })
                    : t("fields.seatsUnlimited", { enrolled: formatNumber(roster.length, locale) })
                }
              />
              <DetailRow label={t("fields.price")} value={formatMoney(classGroup.price, locale)} />
              {showCut ? (
                <DetailRow
                  label={t("fields.centerShare")}
                  value={
                    classGroup.centerShareType === "FIXED"
                      ? t("fields.centerCutFixed", {
                          amount: formatMoney(classGroup.centerShareValue, locale),
                        })
                      : t("fields.centerCutPercent", {
                          value: formatNumber(classGroup.centerShareValue, locale),
                        })
                  }
                />
              ) : null}
            </DetailCard>

            <DetailCard
              title={t("sessions.title")}
              description={t("sessions.description")}
              contentClassName="gap-0"
            >
              <DetailRow
                label={t("period.title")}
                value={formatDayRange(classGroup.startDate, classGroup.endDate, locale)}
              />
              <DetailRow label={t("sessions.count")} value={formatNumber(sessionCount, locale)} />
              {!classGroup.active ? (
                <p className="pt-3 text-xs text-text-muted">{t("sessions.inactiveHint")}</p>
              ) : null}
            </DetailCard>
          </>
        }
      />
    </div>
  );
}
