import { CalendarClock } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { TeacherSessionFilters } from "@/app/[locale]/(teacher)/teacher/sessions/session-filters";
import { SessionRequestForm } from "@/app/[locale]/(teacher)/teacher/sessions/session-request-form";
import { Pagination } from "@/components/center/pagination";
import { SearchBox } from "@/components/center/search-box";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { scoped } from "@/lib/db/scoped";
import { deriveSessionDisplayStatus, sessionDisplayName } from "@/lib/db/sessions";
import { teacherSessionListWhere } from "@/lib/db/teacher-portal";
import { formatDate, formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { addDays, startOfUtcDay } from "@/lib/scheduling";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { teacherSessionListFilterSchema } from "@/lib/validation/teacher";

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
} as const;

const RANGE_SPAN_DAYS = { day: 0, week: 6, month: 29 } as const;

/**
 * The teacher's own session list, across every class they teach at the
 * *active* center only (spec §4.2 item 2: "search by student, filter by
 * date/status/grade... future sessions list"). Switching to a different
 * center is the same `/select-center` flow the dashboard's per-center cards
 * use — this page never queries more than one center at a time.
 */
export default async function TeacherSessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await getTenantContext("teacher");
  const rawParams = await searchParams;
  const parsed = teacherSessionListFilterSchema.safeParse(rawParams);
  const filters = parsed.success
    ? parsed.data
    : { range: "week" as const, date: null, gradeId: null, status: null, q: null };

  const anchor = filters.date
    ? new Date(`${filters.date}T00:00:00.000Z`)
    : startOfUtcDay(new Date());
  const from = anchor;
  const to = addDays(anchor, RANGE_SPAN_DAYS[filters.range]);

  const db = scoped(ctx);
  const t = await getTranslations("TeacherSessions");
  const tCommon = await getTranslations("Settings.common");
  const tStatus = await getTranslations("Sessions.status");
  const locale = await getLocale();

  const [rows, grades, ownClasses] = await Promise.all([
    db.sessions.search({
      where: teacherSessionListWhere({
        teacherId: ctx.user.id,
        from,
        to,
        gradeId: filters.gradeId,
        studentQuery: filters.q,
      }),
    }),
    db.grades.list({ active: true }),
    db.classGroups.list({ teacherId: ctx.user.id, active: true }),
  ]);

  const canRequestSession =
    ctxCan(ctx, "changeRequest.create") && (ctx.membership?.isTrustedTeacher ?? false);
  const classOptions = ownClasses.map((classGroup) => ({
    value: classGroup.id,
    label:
      [
        classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
        classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
      ]
        .filter(Boolean)
        .join(" · ") || tCommon("none"),
  }));

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

  // `grades` comes from `scoped(ctx).grades.list()`, which already resolves
  // `.name` to this centre's own display-name override or the catalog
  // entry's bilingual name.
  const gradeOptions = grades.map((grade) => ({ value: grade.id, label: grade.name }));
  const upcomingCount = withStatus.filter(
    (entry) => entry.displayStatus === "SCHEDULED" || entry.displayStatus === "LIVE",
  ).length;

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (filters.range !== "week") params.set("range", filters.range);
    if (filters.date) params.set("date", filters.date);
    if (filters.gradeId) params.set("gradeId", filters.gradeId);
    if (filters.status) params.set("status", filters.status);
    if (filters.q) params.set("q", filters.q);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.teacherSessions}?${qs}` : ROUTES.teacherSessions;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: total })} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          label={t("stats.inRange")}
          value={formatNumber(total, locale)}
          icon={<CalendarClock className="size-4" />}
        />
        <StatCard
          label={t("stats.upcoming")}
          value={formatNumber(upcomingCount, locale)}
          icon={<CalendarClock className="size-4" />}
          accent="info"
        />
      </div>

      {canRequestSession ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("request.title")}</CardTitle>
            <CardDescription>{t("request.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <SessionRequestForm classes={classOptions} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SearchBox
            value={filters.q ?? ""}
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            submitLabel={t("searchSubmit")}
            keep={{
              range: filters.range !== "week" ? filters.range : undefined,
              date: filters.date ?? undefined,
              gradeId: filters.gradeId ?? undefined,
              status: filters.status ?? undefined,
            }}
          />

          <TeacherSessionFilters
            range={filters.range}
            date={filters.date ?? anchor.toISOString().slice(0, 10)}
            gradeId={filters.gradeId ?? ""}
            status={filters.status ?? ""}
            q={filters.q ?? ""}
            grades={gradeOptions}
            allLabel={t("filters.all")}
          />

          {pageEntries.length === 0 ? (
            <p className="text-sm text-text-muted">{t("empty")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {pageEntries.map(({ row, displayStatus }) => (
                <li key={row.id}>
                  <Link
                    href={ROUTES.teacherSession(row.id)}
                    className="flex flex-col gap-2 rounded-xl border border-border p-4 transition-shadow hover:shadow-card-hover sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {sessionDisplayName(locale, row)}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                        <span>{formatDate(row.date, locale)}</span>
                        <span dir="ltr">
                          {row.startTime}–{row.endTime}
                        </span>
                        <span>{row.room?.name ?? tCommon("none")}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-text-muted">
                        {t("columns.marked", { count: row._count.attendees })}
                      </span>
                      <Badge variant={STATUS_BADGE[displayStatus]}>
                        {tStatus(displayStatus)}
                      </Badge>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
        </CardContent>
      </Card>
    </div>
  );
}
