import { getLocale, getTranslations } from "next-intl/server";

import { studentBranches } from "@/app/[locale]/(student)/student/assessments/scope";
import { CancelBookingButton } from "@/app/[locale]/(student)/student/reservations/cancel-booking-button";
import { LeaveClassButton } from "@/app/[locale]/(student)/student/reservations/leave-class-button";
import { assessmentCalendarEntry, type AssessmentCalendarLabels } from "@/components/shared/assessment-calendar-entry";
import { PageHeader } from "@/components/shared/page-header";
import { SessionCalendar, type CalendarEntry } from "@/components/shared/session-calendar";
import { studentCalendarEntry } from "@/components/shared/student-calendar-entry";
import { getStudentContexts, requireStudentUser } from "@/lib/auth/tenant";
import {
  ASSESSMENT_CALENDAR_TONES,
  STUDENT_CALENDAR_TONES,
  assessmentCalendarWindow,
  assessmentOnCalendar,
  calendarMonthRange,
  parseCalendarDay,
  parseCalendarMonth,
} from "@/lib/calendar";
import { STUDENT_STATE_BADGE, listStudentAssessments } from "@/lib/db/assessment-attempts";
import { prisma } from "@/lib/db/client";
import {
  bookedCalendarEntries,
  studentBookedUpcoming,
  studentCalendarMonth,
  type StudentCalendarEntry,
} from "@/lib/db/student-portal";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone, commonTimeZone, dateKey, todayInTimezone } from "@/lib/scheduling";
import { sessionDisplayName } from "@/lib/session-label";

/**
 * The student's calendar (U7, spec §4.3 item 1a): one month of their own
 * sessions across every branch, read-only. Built from the schedule's own
 * reads — one `studentCalendarMonth` per branch they hold a profile at
 * (`getStudentContexts`, each `centerId`-scoped, each against its own
 * calendar day, R7b), plus the single sessions they booked or requested,
 * identity-scoped like My requests (`studentBookedUpcoming`) — unioned in
 * memory. Every row names its branch; there is no branch to pick.
 *
 * W3b (D-W32) adds the exams and homework this student can see: the assessment
 * list's own read and rules (`listStudentAssessments`), one per branch, limited
 * to the month and placed on the day of the session's frozen timezone, else the
 * branch's. The parent's calendar shares the component and never these rows.
 */
export default async function StudentCalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireStudentUser();
  const contexts = (await getStudentContexts(session.user.id)).filter((ctx) => ctx.studentProfile);
  const rawParams = await searchParams;
  const t = await getTranslations("Calendar");
  const tAssessments = await getTranslations("StudentAssessments");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();
  const now = new Date();

  // The grid's "today" is the zone all this student's branches share, else
  // the platform default (`commonTimeZone`, as the schedule's date picker);
  // each branch's own read below still uses its own day.
  const today = todayInTimezone(commonTimeZone(contexts.map((ctx) => centreTimeZone(ctx.settings))), now);
  const month = parseCalendarMonth(rawParams.month, today);
  const range = calendarMonthRange(month);
  const selectedDay = parseCalendarDay(rawParams.day, month, today);

  const [perBranch, booked, assessments] = await Promise.all([
    Promise.all(
      contexts.map(async (ctx) => ({
        branch: ctx.center.name,
        entries: await studentCalendarMonth(
          prisma,
          ctx.center.id,
          ctx.studentProfile!.id,
          range,
          todayInTimezone(centreTimeZone(ctx.settings), now),
        ),
      })),
    ),
    studentBookedUpcoming(prisma, session.user.id, now),
    studentBranches(session.user.id).then((branches) =>
      Promise.all(
        branches.map(async ({ ctx, student }) => ({
          branch: ctx.center.name,
          zone: centreTimeZone(ctx.settings),
          items: await listStudentAssessments(prisma, student, now, { within: assessmentCalendarWindow(range) }),
        })),
      ),
    ),
  ]);

  const enrolledIds = new Set(perBranch.flatMap((entry) => entry.entries.map((row) => row.sessionId)));
  const branchName = new Map(booked.map((entry) => [entry.centerId, entry.centerName]));
  // U8 — the student's own undo on a day-list row: leave an enrolled class,
  // cancel a booking that has not started. The parent's calendar shares the
  // entry but never this step.
  const withActions = (raw: StudentCalendarEntry, entry: CalendarEntry): CalendarEntry => {
    if (raw.status === "UPCOMING" && raw.classGroupId) {
      return { ...entry, actions: <LeaveClassButton centerId={raw.centerId} classGroupId={raw.classGroupId} /> };
    }
    if ((raw.status === "BOOKED" || raw.status === "REQUESTED") && raw.bookingId && raw.canCancel) {
      return { ...entry, actions: <CancelBookingButton centerId={raw.centerId} bookingId={raw.bookingId} /> };
    }
    return entry;
  };
  const labels: AssessmentCalendarLabels = {
    due: (date) => t("assessmentDue", { date }),
    window: (start, end) => t("assessmentWindow", { start, end }),
  };
  const entries: CalendarEntry[] = [
    ...perBranch.flatMap(({ branch, entries: rows }) =>
      rows.map((row) => withActions(row, studentCalendarEntry(row, branch, locale, tCommon("none")))),
    ),
    ...bookedCalendarEntries(booked, range, enrolledIds, now).map((row) =>
      withActions(row, studentCalendarEntry(row, branchName.get(row.centerId) ?? null, locale, tCommon("none"))),
    ),
    ...assessments.flatMap(({ branch, zone: branchZone, items }) =>
      items.flatMap((item) => {
        const zone = item.timeZone ?? branchZone;
        const placement = assessmentOnCalendar(item, zone, range);
        if (!placement) return [];
        return [
          assessmentCalendarEntry({
            row: item,
            placement,
            zone,
            locale,
            labels,
            className: sessionDisplayName(locale, { classGroup: item.classGroup }),
            branch,
            href: ROUTES.studentAssessment(item.id),
            state: { label: tAssessments(`state.${item.state}`), variant: STUDENT_STATE_BADGE[item.state] },
          }),
        ];
      }),
    ),
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("studentTitle")} description={t("studentSubtitle")} />
      <SessionCalendar
        locale={locale}
        basePath={ROUTES.studentCalendar}
        month={month}
        selectedDay={selectedDay}
        todayKey={dateKey(today)}
        entries={entries}
        legend={[...STUDENT_CALENDAR_TONES, ...ASSESSMENT_CALENDAR_TONES]}
        emptyMonthHint={t("studentEmpty")}
      />
    </div>
  );
}
