import { getLocale, getTranslations } from "next-intl/server";
import { CalendarClock, History } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getStudentContexts, requireStudentUser } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { teacherDisplayNames } from "@/lib/db/discover";
import {
  studentBookedUpcoming,
  studentPastAttendance,
  studentUpcomingSessions,
  type BookedUpcomingSession,
} from "@/lib/db/student-portal";
import { formatDate, formatMoney, formatTime, formatTimeRange } from "@/lib/format";
import { centreTimeZone, commonTimeZone, dateKey, todayInTimezone } from "@/lib/scheduling";
import { ScheduleDateFilter } from "./schedule-date-filter";
import { CappedList } from "@/components/shared/capped-list";
import { EmptyState } from "@/components/shared/empty-state";
import { sessionLabelParts } from "@/lib/session-label";
import { ResultsRegion } from "@/components/shared/results-region";

const ATTENDANCE_BADGE = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "danger",
} as const;

type UpcomingRow = {
  centerId: string;
  centerName: string;
  sessionId: string;
  date: Date;
  startTime: string;
  endTime: string;
  subjectName: string | null;
  gradeName: string | null;
  roomName: string | null;
  teacherName: string;
  /** F6: set on a single-session booking — "Booked" (CONFIRMED) or "Requested" (PENDING). */
  bookingStatus?: "PENDING" | "CONFIRMED";
};

type PastRow = {
  centerId: string;
  centerName: string;
  attendeeId: string;
  date: Date;
  startTime: string;
  subjectName: string | null;
  gradeName: string | null;
  attendanceStatus: "PRESENT" | "LATE" | "ABSENT";
  isDropIn: boolean;
  paidAmount: number | null;
  teacherName: string;
};

async function loadCenterSchedule(
  centerId: string,
  centerName: string,
  studentProfileId: string,
  timeZone: string,
  now: Date,
  locale: string,
): Promise<{ upcoming: UpcomingRow[]; past: PastRow[] }> {
  // R7b: each centre's own calendar day splits its upcoming from its past.
  const today = todayInTimezone(timeZone, now);
  const [futureSessions, history] = await Promise.all([
    studentUpcomingSessions(prisma, centerId, studentProfileId, today),
    studentPastAttendance(prisma, centerId, studentProfileId, today),
  ]);

  const teacherIds = [
    ...new Set([
      ...futureSessions.map((row) => row.teacherId),
      ...history.map((row) => row.session.teacherId),
    ]),
  ];
  const names = await teacherDisplayNames(prisma, centerId, teacherIds);

  const upcoming = futureSessions.map((row) => ({
    centerId,
    centerName,
    sessionId: row.id,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    ...sessionLabelParts(locale, row),
    roomName: row.room?.name ?? row.classGroup?.room?.name ?? null,
    teacherName: names.get(row.teacherId) ?? "—",
  }));

  const past = history.map((row) => ({
    centerId,
    centerName,
    attendeeId: row.id,
    date: row.session.date,
    startTime: row.session.startTime,
    // R5 — a one-time (drop-in only) session shows its own title here.
    ...sessionLabelParts(locale, row.session),
    attendanceStatus: row.attendanceStatus,
    isDropIn: row.isDropIn,
    paidAmount: row.payments[0]?.amount ?? null,
    teacherName: names.get(row.session.teacherId) ?? "—",
  }));

  return { upcoming, past };
}

/**
 * The single sessions this student booked or requested (F6 follow-up), as the
 * same rows an enrolled session draws — read-only, one `centerId`-scoped
 * teacher-name lookup per branch.
 */
async function loadBookedRows(booked: BookedUpcomingSession[], locale: string): Promise<UpcomingRow[]> {
  const centerIds = [...new Set(booked.map((entry) => entry.centerId))];
  const namesByCenter = new Map(
    await Promise.all(
      centerIds.map(
        async (centerId) =>
          [
            centerId,
            await teacherDisplayNames(
              prisma,
              centerId,
              booked.filter((entry) => entry.centerId === centerId).map((entry) => entry.session.teacherId),
            ),
          ] as const,
      ),
    ),
  );
  return booked.map(({ centerId, centerName, bookingStatus, session: row }) => ({
    centerId,
    centerName,
    sessionId: row.id,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    ...sessionLabelParts(locale, row),
    roomName: row.room?.name ?? row.classGroup?.room?.name ?? null,
    teacherName: namesByCenter.get(centerId)?.get(row.teacherId) ?? "—",
    bookingStatus,
  }));
}

/**
 * Student schedule — past + future sessions (spec §4.3 item 1), read-only:
 * a student never marks their own attendance/payment (that stays a
 * center-staff action, CLAUDE.md). Unions each connected center's own
 * queries in memory, the same shape as the teacher dashboard (M7) —
 * `getStudentContexts` gives one `TenantContext` per center this student has
 * a `StudentProfile` at.
 */
export default async function StudentSchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireStudentUser();
  const contexts = await getStudentContexts(session.user.id);
  const rawParams = await searchParams;
  const dateFilter = rawParams.date?.trim() || "";

  const t = await getTranslations("StudentSchedule");
  const tAttendance = await getTranslations("Sessions.attendance");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const now = new Date();

  const [perCenter, bookedRows] = await Promise.all([
    Promise.all(
      contexts
        .filter((ctx) => ctx.studentProfile)
        .map((ctx) =>
          loadCenterSchedule(
            ctx.center.id,
            ctx.center.name,
            ctx.studentProfile!.id,
            centreTimeZone(ctx.settings),
            now,
            locale,
          ),
        ),
    ),
    // F6: single sessions booked or requested. Identity-scoped like My
    // requests, because a PENDING booking can sit at a branch with no profile yet.
    studentBookedUpcoming(prisma, session.user.id, now).then((booked) => loadBookedRows(booked, locale)),
  ]);

  // The date picker's "today" marker is the one combined value on this page.
  // Rule (`commonTimeZone`): the zone all this student's centres share, else
  // the platform default — a cosmetic marker only; every query above used its
  // own centre's day. Pinned by `check:timezone`.
  const todayIso = dateKey(
    todayInTimezone(
      commonTimeZone(
        contexts.filter((ctx) => ctx.studentProfile).map((ctx) => centreTimeZone(ctx.settings)),
      ),
      now,
    ),
  );

  // An enrolled session wins: a student who enrolled after booking sees it once.
  const enrolledSessionIds = new Set(perCenter.flatMap((entry) => entry.upcoming.map((row) => row.sessionId)));
  const upcoming = [
    ...perCenter.flatMap((entry) => entry.upcoming),
    ...bookedRows.filter((row) => !enrolledSessionIds.has(row.sessionId)),
  ]
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.startTime.localeCompare(b.startTime));
  const past = perCenter
    .flatMap((entry) => entry.past)
    .sort((a, b) => b.date.getTime() - a.date.getTime() || b.startTime.localeCompare(a.startTime));

  const upcomingFiltered = dateFilter ? upcoming.filter((row) => dateKey(row.date) === dateFilter) : upcoming;
  const pastFiltered = dateFilter ? past.filter((row) => dateKey(row.date) === dateFilter) : past;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <ScheduleDateFilter
        date={dateFilter}
        todayIso={todayIso}
        dateLabel={t("filterDate")}
      />

      <ResultsRegion className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("upcomingTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {upcomingFiltered.length === 0 ? (
              <EmptyState compact icon={<CalendarClock />} title={t("upcomingEmpty")} description={t("upcomingEmptyHint")} />
            ) : (
              <CappedList
                items={upcomingFiltered}
                moreLabel={(hidden) => t("showMoreUpcoming", { count: hidden })}
                render={(row) => (
                <div
                  key={row.sessionId}
                  className="flex flex-col gap-2 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">
                      {[row.subjectName, row.gradeName].filter(Boolean).join(" · ") || tCommon("none")}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                      <span>{row.centerName}</span>
                      <span>{row.teacherName}</span>
                      <span>{formatDate(row.date, locale)}</span>
                      <span>{formatTimeRange(row.startTime, row.endTime, locale)}</span>
                      {row.roomName ? <span>{row.roomName}</span> : null}
                    </p>
                  </div>
                  <Badge variant={row.bookingStatus === "PENDING" ? "warning" : "info"}>
                    {row.bookingStatus === "CONFIRMED"
                      ? t("bookedBadge")
                      : row.bookingStatus === "PENDING"
                        ? t("requestedBadge")
                        : t("upcomingBadge")}
                  </Badge>
                </div>
                )}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("pastTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pastFiltered.length === 0 ? (
              <EmptyState compact icon={<History />} title={t("pastEmpty")} description={t("pastEmptyHint")} />
            ) : (
              pastFiltered.map((row) => (
                <div
                  key={row.attendeeId}
                  className="flex flex-col gap-2 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">
                      {[row.subjectName, row.gradeName].filter(Boolean).join(" · ") || tCommon("none")}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                      <span>{row.centerName}</span>
                      <span>{row.teacherName}</span>
                      <span>{formatDate(row.date, locale)}</span>
                      <span>{formatTime(row.startTime, locale)}</span>
                      {row.isDropIn ? <span>{t("dropIn")}</span> : null}
                      {row.paidAmount !== null ? <span>{formatMoney(row.paidAmount, locale)}</span> : null}
                    </p>
                  </div>
                  <Badge variant={ATTENDANCE_BADGE[row.attendanceStatus]}>
                    {tAttendance(row.attendanceStatus)}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </ResultsRegion>
    </div>
  );
}
