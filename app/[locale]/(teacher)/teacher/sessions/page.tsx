import { CalendarClock, CalendarSearch, ChevronDown } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { TeacherSessionFilters } from "@/app/[locale]/(teacher)/teacher/sessions/session-filters";
import { SessionRequestForm } from "@/app/[locale]/(teacher)/teacher/sessions/session-request-form";
import { searchOwnSessionStudentsTypeAheadAction } from "@/app/[locale]/(teacher)/teacher/sessions/actions";
import { Pagination } from "@/components/center/pagination";
import { TypeAheadSearch } from "@/components/center/type-ahead-search";
import { PageHeader } from "@/components/shared/page-header";
import { SessionKindBadge } from "@/components/shared/session-kind-badge";
import { StatCard } from "@/components/shared/stat-card";
import { StatGrid } from "@/components/shared/stat-grid";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan } from "@/lib/auth/tenant";
import { branchesInView, getTeacherScope, showsBranches } from "@/lib/auth/teacher-scope";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { scoped } from "@/lib/db/scoped";
import { deriveSessionDisplayStatus } from "@/lib/db/sessions";
import { sessionDisplayName, sessionKind } from "@/lib/session-label";
import { teacherPortalHistoryFloor, teacherSessionListWhere } from "@/lib/db/teacher-portal";
import { clampRangeToVisibility } from "@/lib/db/visibility";
import { formatDate, formatDay, formatNumber, formatTime, formatTimeRange } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { addDays, centreTimeZone, commonTimeZone, dateKey, todayInTimezone } from "@/lib/scheduling";
import { closeEndedSessions } from "@/lib/db/session-lifecycle";
import { prisma } from "@/lib/db/client";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import {
  teacherSessionDateSchema,
  teacherSessionListFilterSchema,
} from "@/lib/validation/teacher";
import { EmptyState } from "@/components/shared/empty-state";
import { ResultsRegion } from "@/components/shared/results-region";

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

const RANGE_SPAN_DAYS = { day: 0, week: 6, month: 29 } as const;

/**
 * The teacher's own session list (spec §4.2 item 2: "search by student, filter
 * by date/status/grade... future sessions list"). U7: across every branch in
 * view — All branches by default — as a **union of per-branch scoped reads**
 * (`scoped(ctx).sessions.search` per branch, merged and paged in memory),
 * never one query spanning branches. Each branch resolves its own "today"
 * (R7b) and its own history floor (U6); each row names its branch, and the
 * Branch filter (`?branch=`) narrows to one.
 */
export default async function TeacherSessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await getTeacherScope();
  const rawParams = await searchParams;
  const parsed = teacherSessionListFilterSchema.safeParse(rawParams);
  // Same rule as the centre list: the date the teacher picked survives a
  // rejected sibling filter rather than being reset alongside it.
  const parsedDate = teacherSessionDateSchema.safeParse(rawParams);
  const dates = parsedDate.success
    ? parsedDate.data
    : { range: "week" as const, date: null };
  const filters = parsed.success
    ? parsed.data
    : { ...dates, gradeId: null, status: null, q: null };
  const branches = branchesInView(scope, rawParams.branch);
  const withBranch = showsBranches(scope);
  const branchFilter = withBranch && branches.length === 1 ? branches[0].center.id : null;

  const t = await getTranslations("TeacherSessions");
  const tCommon = await getTranslations("Settings.common");
  const tStatus = await getTranslations("Sessions.status");
  const tSessions = await getTranslations("Sessions");
  const locale = await getLocale();
  const now = new Date();

  const perBranch = await Promise.all(
    branches.map(async (ctx) => {
      // R7b: each branch's own calendar day — the same "today" its own
      // sessions list and reception desk use.
      const timeZone = centreTimeZone(ctx.settings);
      const today = todayInTimezone(timeZone, now);
      const anchor = filters.date ? new Date(`${filters.date}T00:00:00.000Z`) : today;
      const requestedTo = addDays(anchor, RANGE_SPAN_DAYS[filters.range]);
      // U6: the teacher's own history preference (0 = all history, the
      // default) is the only limit here — never a centre window. A range
      // wholly before the floor reads as empty (start after end).
      const { start: from, end: to } = clampRangeToVisibility(
        { start: anchor, end: requestedTo },
        teacherPortalHistoryFloor(ctx, now),
      );
      // R2's lazy end-of-day close for this teacher's sessions in view.
      // A write, so it covers the whole requested range, not the history view.
      await closeEndedSessions(prisma, ctx.center.id, now, { from: anchor, to: requestedTo, teacherId: ctx.user.id });

      const db = scoped(ctx);
      const [rows, grades] = await Promise.all([
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
      ]);
      return {
        rows: rows.map((row) => ({
          row,
          branch: ctx.center,
          displayStatus: deriveSessionDisplayStatus(row, now, timeZone),
        })),
        grades,
      };
    }),
  );

  // "Request a session" goes to one branch: only branches that grant
  // `changeRequest.create` and mark this teacher trusted (M10), each with its
  // own classes. The action re-resolves the branch it is sent.
  const requestBranches = scope.inView.filter(
    (ctx) => ctxCan(ctx, "changeRequest.create") && (ctx.membership?.isTrustedTeacher ?? false),
  );
  const requestOptions = await Promise.all(
    requestBranches.map(async (ctx) => ({
      id: ctx.center.id,
      name: ctx.center.name,
      classes: (await scoped(ctx).classGroups.list({ teacherId: ctx.user.id, active: true })).map((classGroup) => ({
        value: classGroup.id,
        label:
          [
            classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
            classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
          ]
            .filter(Boolean)
            .join(" · ") || tCommon("none"),
      })),
    })),
  );

  const withStatus = perBranch
    .flatMap((entry) => entry.rows)
    .sort(
      (a, b) =>
        a.row.date.getTime() - b.row.date.getTime() ||
        a.row.startTime.localeCompare(b.row.startTime) ||
        a.branch.name.localeCompare(b.branch.name),
    );
  const filtered = filters.status
    ? withStatus.filter((entry) => entry.displayStatus === filters.status)
    : withStatus;

  const page = parsePageParam(rawParams.page);
  const pageSize = DEFAULT_PAGE_SIZE;
  const total = filtered.length;
  const pageEntries = filtered.slice((page - 1) * pageSize, page * pageSize);

  // Each branch's `scoped(ctx).grades.list()` resolves `.name` to that
  // branch's own display-name override; a catalog grade id means the same
  // grade everywhere (M13), so the union keeps one option per id.
  const gradeOptions = [
    ...new Map(
      perBranch.flatMap((entry) => entry.grades).map((grade) => [grade.id, { value: grade.id, label: grade.name }]),
    ).values(),
  ];
  // The date picker's "today" marker: the zone every branch in view shares,
  // else the platform default — cosmetic; each query used its own day.
  const todayIso = dateKey(todayInTimezone(commonTimeZone(branches.map((ctx) => centreTimeZone(ctx.settings))), now));
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
    if (branchFilter) params.set("branch", branchFilter);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.teacherSessions}?${qs}` : ROUTES.teacherSessions;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: total })} />

      <StatGrid count={2}>
        <StatCard
          label={t("stats.inRange")}
          value={formatNumber(total, locale)}
          icon={<CalendarClock className="size-4" />}
        />
        <StatCard
          label={t("stats.upcoming")}
          value={formatNumber(upcomingCount, locale)}
          icon={<CalendarClock className="size-4" />}
        />
      </StatGrid>

      {/* A request is occasional; the list is what a teacher came for. The
          form is a disclosure, closed until asked for (DES, docs/04 §14.9) —
          it had sat fully open above the list. */}
      {requestOptions.length > 0 ? (
        <Card className="gap-0 py-0">
          <details className="group">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 focus-ring md:px-5 [&::-webkit-details-marker]:hidden">
              <span className="flex min-w-0 flex-col">
                <span className="text-base font-semibold text-text-primary">{t("request.title")}</span>
                <span className="text-sm text-text-secondary">{t("request.description")}</span>
              </span>
              <ChevronDown
                className="size-5 shrink-0 text-text-secondary transition-transform duration-(--motion-base) group-open:rotate-180"
                aria-hidden
              />
            </summary>
            <div className="border-t border-border px-4 py-4 md:px-5">
              <SessionRequestForm branches={requestOptions} />
            </div>
          </details>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TypeAheadSearch
            value={filters.q ?? ""}
            label={t("searchLabel")}
            placeholder={t("searchPlaceholder")}
            submitLabel={t("searchSubmit")}
            keep={{
              range: filters.range !== "week" ? filters.range : undefined,
              date: filters.date ?? undefined,
              gradeId: filters.gradeId ?? undefined,
              status: filters.status ?? undefined,
              branch: branchFilter ?? undefined,
            }}
            search={searchOwnSessionStudentsTypeAheadAction.bind(
              null,
              new URLSearchParams({
                ...(filters.range !== "week" ? { range: filters.range } : {}),
                ...(filters.date ? { date: filters.date } : {}),
                ...(filters.gradeId ? { gradeId: filters.gradeId } : {}),
                ...(filters.status ? { status: filters.status } : {}),
                ...(branchFilter ? { branch: branchFilter } : {}),
              }).toString(),
            )}
          />

          <TeacherSessionFilters
            range={filters.range}
            date={filters.date ?? todayIso}
            todayIso={todayIso}
            gradeId={filters.gradeId ?? ""}
            status={filters.status ?? ""}
            q={filters.q ?? ""}
            grades={gradeOptions}
            allLabel={t("filters.all")}
            branches={withBranch ? scope.inView.map((ctx) => ({ id: ctx.center.id, name: ctx.center.name })) : []}
            branch={branchFilter ?? ""}
          />

          <ResultsRegion className="flex flex-col gap-4">
            {pageEntries.length === 0 ? (
              <EmptyState icon={<CalendarSearch />} tone="warning" title={t("empty")} description={t("emptyHint")} />
            ) : (
              <ul className="flex flex-col gap-3">
                {pageEntries.map(({ row, branch, displayStatus }) => (
                  <li key={row.id}>
                    <Link
                      href={ROUTES.teacherSession(row.id)}
                      className="flex flex-col gap-2 rounded-xl border border-border p-4 transition-ui hover:border-border-strong hover:shadow-card-hover sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                          <span className="min-w-0 truncate">{sessionDisplayName(locale, row)}</span>
                          <SessionKindBadge kind={sessionKind(row)} />
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                          {withBranch ? <span className="font-medium text-text-secondary">{branch.name}</span> : null}
                          <span>{formatDate(row.date, locale)}</span>
                          <span>{formatTimeRange(row.startTime, row.endTime, locale)}</span>
                          <span>{row.room?.name ?? tCommon("none")}</span>
                        </p>
                        {/* U2 — a replacement says where it came from; the original is not listed. */}
                        {row.rescheduledFrom ? (
                          <p className="mt-1 text-xs text-text-secondary">
                            {tSessions("movedFrom", {
                              date: formatDay(row.rescheduledFrom.date, locale),
                              time: formatTime(row.rescheduledFrom.startTime, locale),
                            })}
                          </p>
                        ) : null}
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
          </ResultsRegion>
        </CardContent>
      </Card>
    </div>
  );
}
