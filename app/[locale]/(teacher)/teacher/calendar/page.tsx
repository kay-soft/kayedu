import { getLocale, getTranslations } from "next-intl/server";

import { assessmentCalendarEntry, type AssessmentCalendarLabels } from "@/components/shared/assessment-calendar-entry";
import { PageHeader } from "@/components/shared/page-header";
import { SessionCalendar, type CalendarEntry } from "@/components/shared/session-calendar";
import { BranchFilter } from "@/components/teacher/branch-filter";
import { branchesInView, getTeacherScope, showsBranches } from "@/lib/auth/teacher-scope";
import {
  ASSESSMENT_CALENDAR_TONES,
  TEACHER_CALENDAR_TONES,
  assessmentCalendarWindow,
  assessmentOnCalendar,
  calendarMonthRange,
  parseCalendarDay,
  parseCalendarMonth,
  teacherCalendarTone,
} from "@/lib/calendar";
import { assessmentAttemptCounts, listTeacherAssessments, resolveAssessmentTeacher } from "@/lib/db/assessments";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { closeEndedSessions } from "@/lib/db/session-lifecycle";
import { deriveSessionDisplayStatus } from "@/lib/db/sessions";
import {
  sessionAttendanceCounts,
  teacherPortalHistoryFloor,
  teacherSessionListWhere,
} from "@/lib/db/teacher-portal";
import { clampRangeToVisibility } from "@/lib/db/visibility";
import { formatNumber, formatTimeRange } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone, commonTimeZone, dateKey, todayInTimezone } from "@/lib/scheduling";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * The teacher's calendar (U7, spec §4.2 item 2a): one month of their own
 * sessions — Held (closed), Upcoming, Cancelled — across the branches in view
 * (All branches by default), each a `scoped(ctx).sessions.search` over the
 * same `teacherSessionListWhere` the Sessions list uses, unioned in memory.
 * Each branch reads against its own calendar day (R7b) and the teacher's own
 * history preference (U6), never a centre window. A moved original (U2) is
 * left out by the search itself. The selected day lists each session's
 * present / late / absent and links to it.
 *
 * W3b (D-W32) adds the teacher's own exams and homework at each branch where they
 * may manage them: the list's own read, limited to the month and the same history
 * floor, drafts included and labelled. A draft exam with no window has no day yet.
 * Started and submitted are read for the selected day's published rows only.
 */
export default async function TeacherCalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const scope = await getTeacherScope();
  const rawParams = await searchParams;
  const branches = branchesInView(scope, rawParams.branch);
  const withBranch = showsBranches(scope);
  const branchFilter = withBranch && branches.length === 1 ? branches[0].center.id : null;

  const t = await getTranslations("Calendar");
  const tAssessments = await getTranslations("TeacherAssessments");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();
  const now = new Date();

  // The grid's "today": the zone every branch in view shares, else the
  // platform default — each branch's read below uses its own day.
  const today = todayInTimezone(commonTimeZone(branches.map((ctx) => centreTimeZone(ctx.settings))), now);
  const month = parseCalendarMonth(rawParams.month, today);
  const range = calendarMonthRange(month);
  const selectedDay = parseCalendarDay(rawParams.day, month, today);

  const perBranch = await Promise.all(
    branches.map(async (ctx) => {
      const timeZone = centreTimeZone(ctx.settings);
      const branchToday = todayInTimezone(timeZone, now);
      // R2's lazy end-of-day close, over the month's days that have begun —
      // the same write the Sessions list makes for its range.
      if (range.start.getTime() <= branchToday.getTime()) {
        await closeEndedSessions(prisma, ctx.center.id, now, {
          from: range.start,
          to: range.end.getTime() < branchToday.getTime() ? range.end : branchToday,
          teacherId: ctx.user.id,
        });
      }
      // U6: the teacher's own history preference — never a centre window.
      const { start: from, end: to } = clampRangeToVisibility(range, teacherPortalHistoryFloor(ctx, now));
      const rows = (
        await scoped(ctx).sessions.search({ where: teacherSessionListWhere({ teacherId: ctx.user.id, from, to }) })
      ).filter((row) => deriveSessionDisplayStatus(row, now, timeZone) !== "RESCHEDULED");
      const onDay = selectedDay ? rows.filter((row) => dateKey(row.date) === selectedDay) : [];
      const counts = await sessionAttendanceCounts(prisma, ctx.center.id, onDay);

      const teacher = await resolveAssessmentTeacher(prisma, ctx);
      const assessments = teacher
        ? (await listTeacherAssessments(prisma, teacher, { within: assessmentCalendarWindow({ start: from, end: to }) })).flatMap((row) => {
            const zone = row.session?.timezone ?? timeZone;
            const placement = assessmentOnCalendar(row, zone, { start: from, end: to });
            return placement ? [{ row, zone, placement }] : [];
          })
        : [];
      const attemptCounts = teacher
        ? await assessmentAttemptCounts(
            prisma,
            teacher,
            assessments
              .filter(({ row, placement }) => row.status === "PUBLISHED" && placement.day === selectedDay)
              .map(({ row }) => row.id),
            now,
          )
        : new Map<string, { started: number; submitted: number }>();
      return { ctx, rows, counts, assessments, attemptCounts };
    }),
  );

  const labels: AssessmentCalendarLabels = {
    due: (date) => t("assessmentDue", { date }),
    window: (start, end) => t("assessmentWindow", { start, end }),
  };
  const entries: CalendarEntry[] = perBranch.flatMap(({ ctx, rows, counts, assessments, attemptCounts }) => [
    ...rows.map((row) => ({
      id: row.id,
      day: dateKey(row.date),
      tone: teacherCalendarTone(row),
      time: formatTimeRange(row.startTime, row.endTime, locale),
      startTime: row.startTime,
      title: sessionDisplayName(locale, row) || tCommon("none"),
      branch: withBranch ? ctx.center.name : null,
      room: row.room?.name ?? null,
      href: ROUTES.teacherSession(row.id),
      counts: counts.get(row.id),
    })),
    ...assessments.map(({ row, zone, placement }) => {
      const attempts = attemptCounts.get(row.id) ?? { started: 0, submitted: 0 };
      return assessmentCalendarEntry({
        row,
        placement,
        zone,
        locale,
        labels,
        className: sessionDisplayName(locale, { classGroup: row.classGroup }) || tCommon("none"),
        branch: withBranch ? ctx.center.name : null,
        href: ROUTES.teacherAssessment(row.id),
        state: { label: tAssessments(`status.${row.status}`), variant: row.status === "DRAFT" ? "neutral" : "info" },
        attempts:
          row.status === "PUBLISHED" && placement.day === selectedDay
            ? t("assessmentAttempts", {
                started: formatNumber(attempts.started, locale),
                submitted: formatNumber(attempts.submitted, locale),
              })
            : undefined,
      });
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("teacherTitle")} description={t("teacherSubtitle")} />

      {withBranch ? (
        <BranchFilter
          branches={scope.inView.map((ctx) => ({ id: ctx.center.id, name: ctx.center.name }))}
          value={branchFilter ?? ""}
        />
      ) : null}

      <SessionCalendar
        locale={locale}
        basePath={ROUTES.teacherCalendar}
        keep={{ branch: branchFilter ?? undefined }}
        month={month}
        selectedDay={selectedDay}
        todayKey={dateKey(today)}
        entries={entries}
        legend={[...TEACHER_CALENDAR_TONES, ...ASSESSMENT_CALENDAR_TONES]}
        emptyMonthHint={t("teacherEmpty")}
      />
    </div>
  );
}
