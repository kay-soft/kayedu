import { getLocale, getTranslations } from "next-intl/server";
import { BookOpen, SearchX } from "lucide-react";

import { AddClassDialog } from "@/app/[locale]/(center)/classes/add-class-dialog";
import {
  ClassRow,
  type ClassRowData,
} from "@/app/[locale]/(center)/classes/class-row";
import { ClassFilters } from "@/app/[locale]/(center)/classes/class-filters";
import { HolidayCalendar } from "@/app/[locale]/(center)/classes/holiday-calendar";
import { ListHeader } from "@/components/shared/list-header";
import { Pagination } from "@/components/center/pagination";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { classSessionCounts } from "@/lib/db/class-sessions";
import { classListWhere } from "@/lib/db/classes";
import { prisma } from "@/lib/db/client";
import { classRoomSetFrom } from "@/lib/db/room-sets";
import { scoped } from "@/lib/db/scoped";
import { formatDayRange } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { dateKey } from "@/lib/scheduling";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { ResultsRegion } from "@/components/shared/results-region";

/**
 * Classes (spec §4.1 item 3) — a filterable dashboard first, exactly like
 * Teachers/Students. "Add class" opens a dialog; the class detail page owns
 * its schedule (docs/04 §9) and its roster. Each row shows the class's period
 * and how many sessions it has (R4 — they exist for the whole period, there
 * is no generator to run). The holiday calendar lives here because it
 * applies to every class at once (docs/02 §11).
 */
export default async function ClassesPage({
  searchParams,
}: {
  searchParams: Promise<{
    teacherId?: string;
    subjectId?: string;
    gradeId?: string;
    page?: string;
  }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "class.manage");

  const { teacherId, subjectId, gradeId, page: pageParam } = await searchParams;
  const page = parsePageParam(pageParam);
  const pageSize = DEFAULT_PAGE_SIZE;

  const db = scoped(ctx);
  const locale = await getLocale();
  const t = await getTranslations("Classes");
  const tCommon = await getTranslations("Settings.common");

  const where = classListWhere({
    teacherId: teacherId || null,
    subjectId: subjectId || null,
    gradeId: gradeId || null,
  });

  const [classes, total, teachers, subjects, grades, educationSystems, rooms, roomLinks, holidays, terms] =
    await Promise.all([
      db.classGroups.search({
        where,
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      db.classGroups.count(where),
      db.teachers.list({ active: true }),
      db.subjects.list(),
      db.grades.list(),
      db.educationSystems.list(),
      db.rooms.list(),
      db.roomLinks.list(),
      db.holidays.list(),
      db.terms.listActive(),
    ]);
  const sessionCounts = await classSessionCounts(
    prisma,
    ctx.center.id,
    classes.map((classGroup) => classGroup.id),
  );

  const teacherByUserId = new Map(
    teachers.map((teacher) => [
      teacher.userId,
      fullName(localName(teacher, teacher.user)),
    ]),
  );

  const rows: ClassRowData[] = classes.map((classGroup) => {
    const roomSet = classRoomSetFrom(classGroup);
    return {
      classGroupId: classGroup.id,
      teacherName: teacherByUserId.get(classGroup.teacherId) ?? tCommon("none"),
      subjectName: classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
      gradeName: classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
      roomName: roomSet.rooms.map((room) => room.name).join(" + ") || null,
      price: classGroup.price,
      seats: roomSet.capacity,
      enrolledCount: classGroup._count.enrollments,
      scheduleCount: classGroup._count.schedules,
      period: formatDayRange(classGroup.startDate, classGroup.endDate, locale),
      sessionCount: sessionCounts.get(classGroup.id) ?? 0,
      active: classGroup.active,
    };
  });

  const teacherOptions = teachers.map((teacher) => ({
    value: teacher.userId,
    label: fullName(localName(teacher, teacher.user)),
    // The centre's own phone for them (docs/01 §6) — what the picker searches.
    phone: teacher.phone,
  }));
  // The list filter keeps every entry (an existing class may use one the
  // platform has since deactivated); the New class dialog offers only the
  // entries still on offer (R8).
  const toOption = (row: { id: string; name: string; active: boolean }) => ({
    value: row.id,
    label: row.active ? row.name : `${row.name} · ${tCommon("inactive")}`,
  });
  const subjectOptions = subjects.map(toOption);
  const gradeOptions = grades.map(toOption);
  const pickableSubjectOptions = subjects.filter((row) => row.catalogActive).map(toOption);
  const pickableGradeOptions = grades.filter((row) => row.catalogActive).map(toOption);
  const educationSystemOptions = educationSystems
    .filter((system) => system.catalogActive)
    .map((system) => ({
      value: system.id,
      label: system.active
        ? system.name
        : `${system.name} · ${tCommon("inactive")}`,
    }));
  const roomOptions = rooms.map((room) => ({
    id: room.id,
    name: room.name,
    capacity: room.capacity,
    active: room.active,
  }));
  const educationSystemDefaultFixedShare = Object.fromEntries(
    educationSystems.map((system) => [system.id, system.defaultFixedCenterShare]),
  );

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (teacherId) params.set("teacherId", teacherId);
    if (subjectId) params.set("subjectId", subjectId);
    if (gradeId) params.set("gradeId", gradeId);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.centerClasses}?${qs}` : ROUTES.centerClasses;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle", { count: total })}
        action={
          <AddClassDialog
            teachers={teacherOptions}
            subjects={pickableSubjectOptions}
            grades={pickableGradeOptions}
            educationSystems={educationSystemOptions}
            educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
            rooms={roomOptions}
            roomLinks={roomLinks}
            terms={terms.map((term) => ({
              id: term.id,
              name: term.name,
              startDate: dateKey(term.startDate),
              endDate: dateKey(term.endDate),
            }))}
            noneLabel={tCommon("none")}
            defaults={{
              centerShareType: ctx.settings?.defaultShareType ?? "PERCENTAGE",
              centerShareValue: ctx.settings?.defaultShareValue ?? 15,
              lateThresholdMinutes: ctx.settings?.defaultLateThreshold ?? 10,
            }}
          />
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ClassFilters
            teacherId={teacherId ?? ""}
            subjectId={subjectId ?? ""}
            gradeId={gradeId ?? ""}
            teachers={teacherOptions}
            subjects={subjectOptions}
            grades={gradeOptions}
            allLabel={t("filters.all")}
          />

          <ResultsRegion className="flex flex-col gap-4">
            {rows.length === 0 ? (
              teacherId || subjectId || gradeId ? (
                <EmptyState
                  icon={<SearchX />}
                  tone="warning"
                  title={t("noMatches")}
                  description={t("noMatchesHint")}
                  action={
                    <LinkButton href={ROUTES.centerClasses} size="sm" soft>
                      {t("clearFilters")}
                    </LinkButton>
                  }
                />
              ) : (
                <EmptyState
                  icon={<BookOpen />}
                  title={t("empty")}
                  description={t("emptyHint")}
                />
              )
            ) : (
              <ul className="flex flex-col gap-3 md:gap-0">
                <ListHeader>
                  <span className="min-w-0 flex-[2]">{t("columns.subject")}</span>
                  <span className="min-w-0 flex-1">{t("columns.teacher")}</span>
                  <span className="hidden min-w-0 flex-1 lg:block">{t("columns.room")}</span>
                  <span className="w-24 shrink-0 text-end">{t("columns.price")}</span>
                  <span className="w-20 shrink-0 text-end">{t("columns.enrolled")}</span>
                  <span className="w-24 shrink-0">{tCommon("status")}</span>
                  <span className="w-32 shrink-0 text-end">
                    {tCommon("actions")}
                  </span>
                </ListHeader>

                {rows.map((classGroup) => (
                  <ClassRow
                    key={classGroup.classGroupId}
                    classGroup={classGroup}
                    canManage={ctxCan(ctx, "class.manage")}
                  />
                ))}
              </ul>
            )}

            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              buildHref={buildHref}
            />
          </ResultsRegion>
        </CardContent>
      </Card>

      <Card className="lg:max-w-2xl">
        <CardHeader>
          <CardTitle>{t("holidays.title")}</CardTitle>
          <CardDescription>{t("holidays.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <HolidayCalendar
            holidays={holidays.map((holiday) => ({
              id: holiday.id,
              date: holiday.date.toISOString(),
              name: holiday.name,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
