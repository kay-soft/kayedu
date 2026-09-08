import { getLocale, getTranslations } from "next-intl/server";
import { CalendarClock, History } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getStudentContexts, requireStudentUser } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { teacherDisplayNames } from "@/lib/db/discover";
import { studentPastAttendance, studentUpcomingSessions } from "@/lib/db/student-portal";
import { formatDate, formatMoney, formatTime, formatTimeRange } from "@/lib/format";
import { startOfUtcDay } from "@/lib/scheduling";
import { ScheduleDateFilter } from "./schedule-date-filter";
import { EmptyState } from "@/components/shared/empty-state";

const ATTENDANCE_BADGE = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "danger",
  EXCUSED: "neutral",
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
};

type PastRow = {
  centerId: string;
  centerName: string;
  attendeeId: string;
  date: Date;
  startTime: string;
  subjectName: string | null;
  gradeName: string | null;
  attendanceStatus: "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";
  isDropIn: boolean;
  paidAmount: number | null;
  teacherName: string;
};

async function loadCenterSchedule(
  centerId: string,
  centerName: string,
  studentProfileId: string,
  today: Date,
  locale: string,
): Promise<{ upcoming: UpcomingRow[]; past: PastRow[] }> {
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
    subjectName: row.classGroup.subject ? catalogLabelWithSelection(locale, row.classGroup.subject) : null,
    gradeName: row.classGroup.grade ? catalogLabelWithSelection(locale, row.classGroup.grade) : null,
    roomName: row.room?.name ?? row.classGroup.room?.name ?? null,
    teacherName: names.get(row.teacherId) ?? "—",
  }));

  const past = history.map((row) => ({
    centerId,
    centerName,
    attendeeId: row.id,
    date: row.session.date,
    startTime: row.session.startTime,
    subjectName: row.session.classGroup.subject ? catalogLabelWithSelection(locale, row.session.classGroup.subject) : null,
    gradeName: row.session.classGroup.grade ? catalogLabelWithSelection(locale, row.session.classGroup.grade) : null,
    attendanceStatus: row.attendanceStatus,
    isDropIn: row.isDropIn,
    paidAmount: row.payments[0]?.amount ?? null,
    teacherName: names.get(row.session.teacherId) ?? "—",
  }));

  return { upcoming, past };
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

  const today = startOfUtcDay(new Date());

  const perCenter = await Promise.all(
    contexts
      .filter((ctx) => ctx.studentProfile)
      .map((ctx) => loadCenterSchedule(ctx.center.id, ctx.center.name, ctx.studentProfile!.id, today, locale)),
  );

  const upcoming = perCenter
    .flatMap((entry) => entry.upcoming)
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.startTime.localeCompare(b.startTime));
  const past = perCenter
    .flatMap((entry) => entry.past)
    .sort((a, b) => b.date.getTime() - a.date.getTime() || b.startTime.localeCompare(a.startTime));

  const dayKey = (date: Date) => date.toISOString().slice(0, 10);
  const upcomingFiltered = dateFilter ? upcoming.filter((row) => dayKey(row.date) === dateFilter) : upcoming;
  const pastFiltered = dateFilter ? past.filter((row) => dayKey(row.date) === dateFilter) : past;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <ScheduleDateFilter
        date={dateFilter}
        todayIso={today.toISOString().slice(0, 10)}
        dateLabel={t("filterDate")}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("upcomingTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {upcomingFiltered.length === 0 ? (
            <EmptyState compact icon={<CalendarClock />} title={t("upcomingEmpty")} description={t("upcomingEmptyHint")} />
          ) : (
            upcomingFiltered.map((row) => (
              <div
                key={row.sessionId}
                className="flex flex-col gap-2 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    {[row.subjectName, row.gradeName].filter(Boolean).join(" · ") || tCommon("none")}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                    <span>{row.centerName}</span>
                    <span>{row.teacherName}</span>
                    <span>{formatDate(row.date, locale)}</span>
                    <span>{formatTimeRange(row.startTime, row.endTime, locale)}</span>
                    {row.roomName ? <span>{row.roomName}</span> : null}
                  </p>
                </div>
                <Badge variant="info">{t("upcomingBadge")}</Badge>
              </div>
            ))
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
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
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
    </div>
  );
}
