import { getLocale, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shared/page-header";
import { SessionCalendar, type CalendarEntry } from "@/components/shared/session-calendar";
import { studentCalendarEntry } from "@/components/shared/student-calendar-entry";
import { getStudentContexts, requireStudentUser } from "@/lib/auth/tenant";
import {
  STUDENT_CALENDAR_TONES,
  calendarMonthRange,
  parseCalendarDay,
  parseCalendarMonth,
} from "@/lib/calendar";
import { prisma } from "@/lib/db/client";
import {
  bookedCalendarEntries,
  studentBookedUpcoming,
  studentCalendarMonth,
} from "@/lib/db/student-portal";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone, commonTimeZone, dateKey, todayInTimezone } from "@/lib/scheduling";

/**
 * The student's calendar (U7, spec §4.3 item 1a): one month of their own
 * sessions across every branch, read-only. Built from the schedule's own
 * reads — one `studentCalendarMonth` per branch they hold a profile at
 * (`getStudentContexts`, each `centerId`-scoped, each against its own
 * calendar day, R7b), plus the single sessions they booked or requested,
 * identity-scoped like My requests (`studentBookedUpcoming`) — unioned in
 * memory. Every row names its branch; there is no branch to pick.
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

  const [perBranch, booked] = await Promise.all([
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
  ]);

  const enrolledIds = new Set(perBranch.flatMap((entry) => entry.entries.map((row) => row.sessionId)));
  const branchName = new Map(booked.map((entry) => [entry.centerId, entry.centerName]));
  const entries: CalendarEntry[] = [
    ...perBranch.flatMap(({ branch, entries: rows }) =>
      rows.map((row) => studentCalendarEntry(row, branch, locale, tCommon("none"))),
    ),
    ...bookedCalendarEntries(booked, range, enrolledIds).map((row) =>
      studentCalendarEntry(row, branchName.get(row.centerId) ?? null, locale, tCommon("none")),
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
        legend={STUDENT_CALENDAR_TONES}
        emptyMonthHint={t("studentEmpty")}
      />
    </div>
  );
}
