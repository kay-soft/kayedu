import { CalendarClock, CalendarSearch, ClipboardCheck, Radio, Wallet } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import {
  NewSessionDialog,
  type NewSessionClassOption,
} from "@/app/[locale]/(center)/sessions/new-session-dialog";
import { SessionFilters } from "@/app/[locale]/(center)/sessions/session-filters";
import { SESSION_COLUMNS, SessionRow, type SessionRowData } from "@/app/[locale]/(center)/sessions/session-row";
import { ListHeader } from "@/components/shared/list-header";
import { cn } from "@/lib/utils";
import { Pagination } from "@/components/center/pagination";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { revenueTotals } from "@/lib/db/analytics";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { deriveSessionDisplayStatus, sessionListWhere } from "@/lib/db/sessions";
import { sessionDisplayName, sessionKind } from "@/lib/session-label";
import { clampRangeToVisibility, visibilityWindowFloor } from "@/lib/db/visibility";
import { formatDay, formatMoney, formatNumber, formatTime } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import {
  centreTimeZone,
  dateKey,
  resolveSharedDateFilter,
  todayInTimezone,
} from "@/lib/scheduling";
import { closeEndedSessions } from "@/lib/db/session-lifecycle";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { sessionListFilterSchema } from "@/lib/validation/sessions";
import { dateFilterSchema, toSharedDateFilterInput } from "@/lib/validation/date-filter";
import { ResultsRegion } from "@/components/shared/results-region";

/**
 * Today's Sessions dashboard (spec §4.1 item 7): a KPI row, filters (date/
 * week/month, teacher, subject, class, status) and a data table. The status
 * filter is derived from the clock (`deriveSessionDisplayStatus`), not a
 * stored column, so — unlike Students/Teachers/Classes — this list is
 * filtered and paginated in memory after one date-bounded query rather than
 * with `take`/`skip` in the database; the date range keeps that query small
 * (one center's day/week/month, never the whole table).
 */
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "session.view");

  const rawParams = await searchParams;
  const parsedFilters = sessionListFilterSchema.safeParse(rawParams);
  // The date part is parsed on its own as well, so a rejected *sibling*
  // filter can never discard a date range the user just picked. Coupling the
  // two is what turned one over-strict enum into "the range resets to today":
  // a single bad field failed the whole object, and the fallback below then
  // silently replaced every filter, dates included.
  const parsedDates = dateFilterSchema.safeParse(rawParams);
  const dates = parsedDates.success
    ? parsedDates.data
    : { range: "day" as const, date: null, from: null, to: null };
  const filters = parsedFilters.success
    ? parsedFilters.data
    : {
        ...dates,
        teacherId: null,
        subjectId: null,
        classGroupId: null,
        status: null,
        moved: false,
      };

  // R7b: the filter's "today", the visibility floor and the picker's today
  // marker are all the centre's calendar day (`todayInTimezone`).
  const now = new Date();
  const timeZone = centreTimeZone(ctx.settings);
  const todayIso = dateKey(todayInTimezone(timeZone, now));
  // Clamped to the data-visibility window (M19, docs/01 §7): a receptionist
  // (etc.) manipulating `?from=` cannot read further back than their centre's
  // window, regardless of what the shared date filter itself would allow.
  const { start: from, end: to } = clampRangeToVisibility(
    resolveSharedDateFilter(toSharedDateFilterInput(filters), timeZone, now),
    visibilityWindowFloor(ctx, now),
  );

  // R2's lazy end-of-day close for every session in view (one indexed query
  // when there is nothing to close), so the list shows closed records as such.
  await closeEndedSessions(prisma, ctx.center.id, now, { from, to });

  const db = scoped(ctx);
  const t = await getTranslations("Sessions");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const where = sessionListWhere({
    from,
    to,
    teacherId: filters.teacherId,
    subjectId: filters.subjectId,
    classGroupId: filters.classGroupId,
  });

  // R5 — "New session" (an extra session on a class, or a one-time one).
  // Only loaded for who may create one; the action re-checks regardless. Its
  // reads go out with the list's own, not after them (docs/08 §4.6.2).
  const canCreate = ctxCan(ctx, "session.manage");

  const [rows, teachers, subjects, classes, revenue, newSession] = await Promise.all([
    db.sessions.search({ where, includeMoved: filters.moved }),
    db.teachers.list({ active: true }),
    db.subjects.list(),
    db.classGroups.list(),
    // A 64-bit sum, net of refunds — the same figure the receipt and
    // Analytics show (SEC-2b: SEC-19, SEC-24).
    revenueTotals(prisma, ctx.center.id, { from, to }),
    canCreate
      ? Promise.all([
            db.classGroups.listForNewSession(),
            db.subjects.list({ active: true }),
            db.grades.list({ active: true }),
            db.rooms.list(),
            db.roomLinks.list(),
          ]).then(([activeClasses, activeSubjects, activeGrades, rooms, roomLinks]) => ({
            classes: activeClasses.map((classGroup): NewSessionClassOption => {
              const label = sessionDisplayName(locale, { classGroup });
              return {
                id: classGroup.id,
                label: label === "—" ? t("columns.untitled") : label,
                teacherId: classGroup.teacherId,
                roomId: classGroup.roomId ?? "",
                extraRoomIds: classGroup.roomId ? classGroup.extraRooms.map((extra) => extra.roomId) : [],
                slots: classGroup.schedules,
              };
            }),
            subjects: activeSubjects.map((subject) => ({ value: subject.id, label: subject.name })),
            grades: activeGrades.map((grade) => ({ value: grade.id, label: grade.name })),
            rooms: rooms.map((room) => ({
              id: room.id,
              name: room.name,
              capacity: room.capacity,
              active: room.active,
            })),
            roomLinks,
          }))
      : null,
  ]);

  const withStatus = rows.map((row) => ({
    row,
    displayStatus: deriveSessionDisplayStatus(row, now, timeZone),
  }));
  const filtered = filters.status
    ? withStatus.filter((entry) => entry.displayStatus === filters.status)
    : withStatus;

  const page = parsePageParam(rawParams.page);
  const pageSize = DEFAULT_PAGE_SIZE;
  const total = filtered.length;
  const pageEntries = filtered.slice((page - 1) * pageSize, page * pageSize);

  const teacherByUserId = new Map(
    teachers.map((teacher) => [teacher.userId, fullName(localName(teacher, teacher.user))]),
  );

  const slotLabel = (slot: { date: Date; startTime: string }) => ({
    date: formatDay(slot.date, locale),
    time: formatTime(slot.startTime, locale),
  });

  const tableRows: SessionRowData[] = pageEntries.map(({ row, displayStatus }) => ({
    sessionId: row.id,
    className: sessionDisplayName(locale, row),
    kind: sessionKind(row),
    teacherName: teacherByUserId.get(row.teacherId) ?? tCommon("none"),
    roomName: row.room?.name ?? null,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    price: row.priceSnapshot,
    attendeeCount: row._count.attendees,
    // A one-time session (R5) has no class, so nobody is enrolled in it.
    enrolledCount: row.classGroup?._count.enrollments ?? 0,
    displayStatus,
    // U2 — "Moved to …" on a moved original (greyed), "Moved from …" on its replacement.
    movedTo: row.rescheduledTo ? slotLabel(row.rescheduledTo) : null,
    movedFrom: row.rescheduledFrom ? slotLabel(row.rescheduledFrom) : null,
  }));

  const liveCount = filtered.filter((entry) => entry.displayStatus === "LIVE").length;
  const markedCount = filtered.reduce((sum, entry) => sum + entry.row._count.attendees, 0);

  const teacherOptions = teachers.map((teacher) => ({
    value: teacher.userId,
    label: fullName(localName(teacher, teacher.user)),
    // The centre's own phone for them (docs/01 §6) — what the picker searches.
    phone: teacher.phone,
  }));
  // `subjects` comes from `scoped(ctx).subjects.list()`, which already
  // resolves `.name` to this centre's own display-name override or the
  // catalog entry's bilingual name.
  const subjectOptions = subjects.map((subject) => ({ value: subject.id, label: subject.name }));
  const classOptions = classes.map((classGroup) => ({
    value: classGroup.id,
    label:
      [
        classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
        classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
      ]
        .filter(Boolean)
        .join(" · ") || t("columns.untitled"),
  }));

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (filters.range !== "day") params.set("range", filters.range);
    if (filters.date) params.set("date", filters.date);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    if (filters.teacherId) params.set("teacherId", filters.teacherId);
    if (filters.subjectId) params.set("subjectId", filters.subjectId);
    if (filters.classGroupId) params.set("classGroupId", filters.classGroupId);
    if (filters.status) params.set("status", filters.status);
    if (filters.moved) params.set("moved", "on");
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.centerSessions}?${qs}` : ROUTES.centerSessions;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle", { count: total })}
        action={
          newSession ? (
            <NewSessionDialog
              classes={newSession.classes}
              teachers={teacherOptions}
              subjects={newSession.subjects}
              grades={newSession.grades}
              rooms={newSession.rooms}
              roomLinks={newSession.roomLinks}
              defaultCut={{
                centerShareType: ctx.settings?.defaultShareType ?? "PERCENTAGE",
                centerShareValue: ctx.settings?.defaultShareValue ?? 15,
              }}
              todayIso={todayIso}
              noneLabel={tCommon("none")}
            />
          ) : undefined
        }
      />

      <StatGrid count={4}>
        <StatCard
          label={t("stats.total")}
          value={formatNumber(total, locale)}
          icon={<CalendarClock className="size-4" />}
        />
        <StatCard
          label={t("stats.live")}
          value={formatNumber(liveCount, locale)}
          icon={<Radio className="size-4" />}
        />
        <StatCard
          label={t("stats.marked")}
          value={formatNumber(markedCount, locale)}
          icon={<ClipboardCheck className="size-4" />}
        />
        <StatCard
          label={t("stats.collected")}
          value={formatMoney(revenue.collected, locale)}
          icon={<Wallet className="size-4" />}
          zero={revenue.collected === 0}
          zeroLabel={t("zeroHint")}
        />
      </StatGrid>

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SessionFilters
            dateFilter={{
              range: filters.range,
              date: filters.date ?? "",
              from: filters.from ?? "",
              to: filters.to ?? "",
            }}
            todayIso={todayIso}
            resetHref={ROUTES.centerSessions}
            teacherId={filters.teacherId ?? ""}
            subjectId={filters.subjectId ?? ""}
            classGroupId={filters.classGroupId ?? ""}
            status={filters.status ?? ""}
            moved={filters.moved}
            teachers={teacherOptions}
            subjects={subjectOptions}
            classes={classOptions}
            allLabel={t("filters.all")}
          />

          <ResultsRegion className="flex flex-col gap-4">
            {tableRows.length === 0 ? (
              <EmptyState
                icon={<CalendarSearch />}
                tone="warning"
                title={t("empty")}
                description={t("emptyHint")}
                action={
                  <LinkButton href={ROUTES.centerSessions} size="sm" soft>
                    {t("clearFilters")}
                  </LinkButton>
                }
              />
            ) : (
              <ul className="flex flex-col gap-3 md:gap-0">
                <ListHeader>
                  <span className={SESSION_COLUMNS.when}>{t("columns.when")}</span>
                  <span className={SESSION_COLUMNS.name}>{t("columns.class")}</span>
                  <span className={SESSION_COLUMNS.teacher}>{t("columns.teacher")}</span>
                  <span className={cn("hidden lg:block", SESSION_COLUMNS.room)}>{t("columns.room")}</span>
                  <span className={SESSION_COLUMNS.marked}>{t("columns.marked")}</span>
                  <span className={SESSION_COLUMNS.price}>{t("columns.price")}</span>
                  <span className={SESSION_COLUMNS.status}>{tCommon("status")}</span>
                </ListHeader>

                {tableRows.map((row) => (
                  <SessionRow key={row.sessionId} session={row} locale={locale} />
                ))}
              </ul>
            )}

            <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
          </ResultsRegion>
        </CardContent>
      </Card>
    </div>
  );
}
