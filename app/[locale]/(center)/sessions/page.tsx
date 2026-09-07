import { CalendarClock, ClipboardCheck, Radio, Wallet } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { SessionFilters } from "@/app/[locale]/(center)/sessions/session-filters";
import { SessionRow, type SessionRowData } from "@/app/[locale]/(center)/sessions/session-row";
import { Pagination } from "@/components/center/pagination";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabel } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import {
  deriveSessionDisplayStatus,
  sessionDisplayName,
  sessionListWhere,
} from "@/lib/db/sessions";
import { formatMoney, formatNumber } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { monthRangeUtc, startOfUtcDay, weekRangeUtc } from "@/lib/scheduling";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { sessionListFilterSchema } from "@/lib/validation/sessions";

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
  await requirePermission(ctx, "session.view");

  const rawParams = await searchParams;
  const parsedFilters = sessionListFilterSchema.safeParse(rawParams);
  const filters = parsedFilters.success
    ? parsedFilters.data
    : { range: "day" as const, date: null, teacherId: null, subjectId: null, classGroupId: null, status: null };

  const anchor = filters.date
    ? new Date(`${filters.date}T00:00:00.000Z`)
    : startOfUtcDay(new Date());

  const { start: from, end: to } =
    filters.range === "week"
      ? weekRangeUtc(anchor)
      : filters.range === "month"
        ? monthRangeUtc(anchor)
        : { start: anchor, end: anchor };

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

  const [rows, teachers, subjects, classes, paymentAgg] = await Promise.all([
    db.sessions.search({ where }),
    db.teachers.list({ active: true }),
    db.subjects.list(),
    db.classGroups.list(),
    prisma.payment.aggregate({
      where: {
        centerId: ctx.center.id,
        voided: false,
        session: { date: { gte: from, lte: to } },
      },
      _sum: { amount: true },
    }),
  ]);

  const now = new Date();
  const withStatus = rows.map((row) => ({
    row,
    displayStatus: deriveSessionDisplayStatus(row, now),
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

  const tableRows: SessionRowData[] = pageEntries.map(({ row, displayStatus }) => ({
    sessionId: row.id,
    className: sessionDisplayName(locale, row),
    teacherName: teacherByUserId.get(row.teacherId) ?? tCommon("none"),
    roomName: row.room?.name ?? null,
    startTime: row.startTime,
    endTime: row.endTime,
    price: row.priceSnapshot,
    attendeeCount: row._count.attendees,
    enrolledCount: row.classGroup._count.enrollments,
    displayStatus,
  }));

  const liveCount = filtered.filter((entry) => entry.displayStatus === "LIVE").length;
  const markedCount = filtered.reduce((sum, entry) => sum + entry.row._count.attendees, 0);

  const teacherOptions = teachers.map((teacher) => ({
    value: teacher.userId,
    label: fullName(localName(teacher, teacher.user)),
  }));
  const subjectOptions = subjects.map((subject) => ({ value: subject.id, label: catalogLabel(locale, subject) }));
  const classOptions = classes.map((classGroup) => ({
    value: classGroup.id,
    label:
      [
        classGroup.subject ? catalogLabel(locale, classGroup.subject) : null,
        classGroup.grade ? catalogLabel(locale, classGroup.grade) : null,
      ]
        .filter(Boolean)
        .join(" · ") || t("columns.untitled"),
  }));

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (filters.range !== "day") params.set("range", filters.range);
    if (filters.date) params.set("date", filters.date);
    if (filters.teacherId) params.set("teacherId", filters.teacherId);
    if (filters.subjectId) params.set("subjectId", filters.subjectId);
    if (filters.classGroupId) params.set("classGroupId", filters.classGroupId);
    if (filters.status) params.set("status", filters.status);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.centerSessions}?${qs}` : ROUTES.centerSessions;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: total })} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t("stats.total")}
          value={formatNumber(total, locale)}
          icon={<CalendarClock className="size-4" />}
        />
        <StatCard
          label={t("stats.live")}
          value={formatNumber(liveCount, locale)}
          icon={<Radio className="size-4" />}
          accent="success"
        />
        <StatCard
          label={t("stats.marked")}
          value={formatNumber(markedCount, locale)}
          icon={<ClipboardCheck className="size-4" />}
        />
        <StatCard
          label={t("stats.collected")}
          value={formatMoney(paymentAgg._sum.amount ?? 0, locale)}
          icon={<Wallet className="size-4" />}
          accent="brand"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SessionFilters
            range={filters.range}
            date={filters.date ?? anchor.toISOString().slice(0, 10)}
            teacherId={filters.teacherId ?? ""}
            subjectId={filters.subjectId ?? ""}
            classGroupId={filters.classGroupId ?? ""}
            status={filters.status ?? ""}
            teachers={teacherOptions}
            subjects={subjectOptions}
            classes={classOptions}
            allLabel={t("filters.all")}
          />

          {tableRows.length === 0 ? (
            <p className="text-sm text-text-muted">{t("empty")}</p>
          ) : (
            <ul className="flex flex-col gap-3 md:gap-0">
              <li
                aria-hidden
                className="hidden items-center gap-4 border-b border-border px-2 pb-2 text-xs font-medium text-text-muted md:flex"
              >
                <span className="w-24 shrink-0">{t("columns.time")}</span>
                <span className="min-w-0 flex-1">{t("columns.class")}</span>
                <span className="min-w-0 flex-1">{t("columns.teacher")}</span>
                <span className="min-w-0 flex-1">{t("columns.room")}</span>
                <span className="w-28 shrink-0">{t("columns.marked")}</span>
                <span className="w-28 shrink-0">{t("columns.price")}</span>
                <span className="w-28 shrink-0">{tCommon("status")}</span>
                <span className="w-24 shrink-0 text-end">{tCommon("actions")}</span>
              </li>

              {tableRows.map((row) => (
                <SessionRow key={row.sessionId} session={row} locale={locale} />
              ))}
            </ul>
          )}

          <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
        </CardContent>
      </Card>
    </div>
  );
}
