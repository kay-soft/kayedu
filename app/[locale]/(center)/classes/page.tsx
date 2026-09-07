import { getLocale, getTranslations } from "next-intl/server";

import { AddClassDialog } from "@/app/[locale]/(center)/classes/add-class-dialog";
import {
  ClassRow,
  type ClassRowData,
} from "@/app/[locale]/(center)/classes/class-row";
import { ClassFilters } from "@/app/[locale]/(center)/classes/class-filters";
import { GenerateSessionsButton } from "@/app/[locale]/(center)/classes/generate-sessions-button";
import { HolidayCalendar } from "@/app/[locale]/(center)/classes/holiday-calendar";
import { Pagination } from "@/components/center/pagination";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { classListWhere } from "@/lib/db/classes";
import { scoped } from "@/lib/db/scoped";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { catalogLabelWithSelection } from "@/lib/catalog";

/**
 * Classes (spec §4.1 item 3) — a filterable dashboard first, exactly like
 * Teachers/Students. "Add class" opens a dialog; the class detail page owns
 * its schedule (docs/04 §9), its roster and its own "generate sessions"
 * trigger. The holiday calendar and a center-wide "generate sessions" live
 * here because they apply to every class at once (docs/02 §11).
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

  const [classes, total, teachers, subjects, grades, educationSystems, rooms, holidays] =
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
      db.holidays.list(),
    ]);

  const teacherByUserId = new Map(
    teachers.map((teacher) => [
      teacher.userId,
      fullName(localName(teacher, teacher.user)),
    ]),
  );

  const rows: ClassRowData[] = classes.map((classGroup) => ({
    classGroupId: classGroup.id,
    teacherName: teacherByUserId.get(classGroup.teacherId) ?? tCommon("none"),
    subjectName: classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
    gradeName: classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
    roomName: classGroup.room?.name ?? null,
    price: classGroup.price,
    capacity: classGroup.capacity,
    enrolledCount: classGroup._count.enrollments,
    scheduleCount: classGroup._count.schedules,
    active: classGroup.active,
  }));

  const teacherOptions = teachers.map((teacher) => ({
    value: teacher.userId,
    label: fullName(localName(teacher, teacher.user)),
  }));
  const subjectOptions = subjects.map((subject) => ({
    value: subject.id,
    label: subject.active
      ? subject.name
      : `${subject.name} · ${tCommon("inactive")}`,
  }));
  const gradeOptions = grades.map((grade) => ({
    value: grade.id,
    label: grade.active ? grade.name : `${grade.name} · ${tCommon("inactive")}`,
  }));
  const educationSystemOptions = educationSystems.map((system) => ({
    value: system.id,
    label: system.active
      ? system.name
      : `${system.name} · ${tCommon("inactive")}`,
  }));
  const roomOptions = rooms.map((room) => ({
    value: room.id,
    label: room.active ? room.name : `${room.name} · ${tCommon("inactive")}`,
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
            subjects={subjectOptions}
            grades={gradeOptions}
            educationSystems={educationSystemOptions}
            educationSystemDefaultFixedShare={educationSystemDefaultFixedShare}
            rooms={roomOptions}
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

          {rows.length === 0 ? (
            <p className="text-sm text-text-muted">
              {teacherId || subjectId || gradeId ? t("noMatches") : t("empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              <li
                aria-hidden
                className="hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex"
              >
                <span className="min-w-0 flex-1">{t("columns.subject")}</span>
                <span className="min-w-0 flex-1">{t("columns.teacher")}</span>
                <span className="min-w-0 flex-1">{t("columns.room")}</span>
                <span className="w-28 shrink-0">{t("columns.price")}</span>
                <span className="w-28 shrink-0">{t("columns.enrolled")}</span>
                <span className="w-24 shrink-0">{tCommon("status")}</span>
                <span className="w-44 shrink-0 text-end">
                  {tCommon("actions")}
                </span>
              </li>

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
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Card>
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

        <Card>
          <CardHeader>
            <CardTitle>{t("generate.title")}</CardTitle>
            <CardDescription>{t("generate.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <GenerateSessionsButton />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
