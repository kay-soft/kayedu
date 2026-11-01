import { getLocale, getTranslations } from "next-intl/server";
import { CalendarClock, History, Link2, Users } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireParentUser } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { teacherDisplayNames } from "@/lib/db/discover";
import { childBookedUpcoming, studentPastAttendance, studentUpcomingSessions } from "@/lib/db/student-portal";
import { formatDate, formatDay, formatMoney, formatTime, formatTimeRange } from "@/lib/format";
import { centerTimeZone } from "@/lib/db/session-lifecycle";
import { dateKey, todayInTimezone } from "@/lib/scheduling";
import { ChildSelector } from "./child-selector";
import { ParentDateFilter } from "./parent-date-filter";
import { CappedList } from "@/components/shared/capped-list";
import { EmptyState } from "@/components/shared/empty-state";
import { sessionLabelParts } from "@/lib/session-label";
import { ResultsRegion } from "@/components/shared/results-region";
import { LinkChildPrompt } from "@/components/family/link-child-prompt";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { accountPath } from "@/lib/routes";

const ATTENDANCE_BADGE = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "danger",
} as const;

type UpcomingRow = {
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
  /** U2 — a replacement's original slot ("Moved from …"). */
  movedFrom: { date: Date; startTime: string } | null;
};

type PastRow = {
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

/**
 * The one selected child's schedule — exactly the same reads the student
 * schedule page uses (`lib/db/student-portal.ts`: enrolled sessions, booked or
 * requested single sessions, past attendance), against that child's own
 * `centerId`/`studentProfileId`. This is what makes "never a superset of
 * what the child can see" true by construction: a parent never sees anything
 * this module doesn't already expose to the student themselves.
 */
async function loadChildSchedule(
  centerId: string,
  studentProfileId: string,
  today: Date,
  locale: string,
): Promise<{ upcoming: UpcomingRow[]; past: PastRow[] }> {
  const [futureSessions, history, booked] = await Promise.all([
    studentUpcomingSessions(prisma, centerId, studentProfileId, today),
    studentPastAttendance(prisma, centerId, studentProfileId, today),
    childBookedUpcoming(prisma, centerId, studentProfileId),
  ]);
  // An enrolled session wins: a child who enrolled after booking shows it once.
  const enrolledIds = new Set(futureSessions.map((row) => row.id));
  const bookedSessions = booked.filter((entry) => !enrolledIds.has(entry.session.id));

  const teacherIds = [
    ...new Set([
      ...futureSessions.map((row) => row.teacherId),
      ...bookedSessions.map((entry) => entry.session.teacherId),
      ...history.map((row) => row.session.teacherId),
    ]),
  ];
  const names = await teacherDisplayNames(prisma, centerId, teacherIds);

  const toUpcoming = (row: (typeof futureSessions)[number], bookingStatus?: "PENDING" | "CONFIRMED"): UpcomingRow => ({
    sessionId: row.id,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    ...sessionLabelParts(locale, row),
    roomName: row.room?.name ?? row.classGroup?.room?.name ?? null,
    teacherName: names.get(row.teacherId) ?? "—",
    bookingStatus,
    movedFrom: row.rescheduledFrom,
  });
  const upcoming = [
    ...futureSessions.map((row) => toUpcoming(row)),
    ...bookedSessions.map((entry) => toUpcoming(entry.session, entry.bookingStatus)),
  ].sort((a, b) => a.date.getTime() - b.date.getTime() || a.startTime.localeCompare(b.startTime));

  const past = history.map((row) => ({
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
 * The parent portal (M16, spec §4.5): a child selector plus a read-only
 * mirror of the student schedule, for one selected child at a time — never
 * every child unioned together, since these are separate people's records,
 * not one person's cross-centre view. `requireParentUser()` already narrows
 * `session.children` to ACTIVE family links and each child's active profiles
 * at accessible branches (F3), so a pending code's (or someone else's) child
 * can never be selected, by URL or otherwise: the `?child=` param is
 * re-checked against that list below, never trusted directly. A child linked
 * but at no branch yet is named, with nothing to read.
 */
export default async function ParentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireParentUser();
  const t = await getTranslations("ParentPortal");
  const tAttendance = await getTranslations("Sessions.attendance");
  const tCommon = await getTranslations("Settings.common");
  const tSessions = await getTranslations("Sessions");
  const locale = await getLocale();

  const tErrors = await getTranslations("Family.errors");
  const withoutBranch = session.linkedChildren.filter((child) => child.branchCount === 0);
  const linkAnother = (
    <LinkButton href={accountPath("parent")} variant="ghost" className="w-full text-brand sm:w-fit">
      <Link2 className="size-4" aria-hidden />
      {t("linkAnother")}
    </LinkButton>
  );

  // F3: no linked child yet — "Link your child" (a code field that hands the
  // code to /family/join; nothing here writes).
  if (session.linkedChildren.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t("title")} description={t("subtitle")} />
        <Card>
          <CardContent className="flex flex-col gap-4">
            <EmptyState
              icon={<Users />}
              tone="info"
              title={t("noChildren")}
              description={t("linkDescription")}
              action={<LinkChildPrompt label={t("codeLabel")} continueLabel={t("continue")} invalidLabel={tErrors("invalidCode")} />}
            />
            <p className="text-center text-xs text-text-muted">{t("howToGet")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Linked, but no child is at a branch yet: nothing to read until they join one.
  if (session.children.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={t("title")} description={t("subtitle")} action={linkAnother} />
        <EmptyState
          icon={<Users />}
          tone="info"
          title={t("noBranchTitle")}
          description={t("noBranch", { names: withoutBranch.map((child) => child.childName).join(locale === "ar" ? "، " : ", ") })}
        />
      </div>
    );
  }

  const rawParams = await searchParams;
  const requestedChildId = rawParams.child?.trim();
  const selected =
    session.children.find((child) => child.studentProfileId === requestedChildId) ??
    session.children[0];
  const dateFilter = rawParams.date?.trim() || "";

  // R7b: "today" is the selected child's own centre's calendar day.
  const timeZone = await centerTimeZone(prisma, selected.centerId);
  const today = todayInTimezone(timeZone);
  const { upcoming, past } = await loadChildSchedule(
    selected.centerId,
    selected.studentProfileId,
    today,
    locale,
  );

  const upcomingFiltered = dateFilter ? upcoming.filter((row) => dateKey(row.date) === dateFilter) : upcoming;
  const pastFiltered = dateFilter ? past.filter((row) => dateKey(row.date) === dateFilter) : past;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} action={linkAnother} />

      {withoutBranch.length > 0 ? (
        <FormMessage tone="info">
          {t("noBranch", { names: withoutBranch.map((child) => child.childName).join(locale === "ar" ? "، " : ", ") })}
        </FormMessage>
      ) : null}

      <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        {session.children.length > 1 ? (
          <ChildSelector
            options={session.children.map((child) => ({
              id: child.studentProfileId,
              label: `${child.childName} · ${child.centerName}`,
            }))}
            selectedId={selected.studentProfileId}
            label={t("childSelectorLabel")}
          />
        ) : (
          <div>
            <p className="text-xs font-medium text-text-secondary">{t("childSelectorLabel")}</p>
            <p className="text-sm text-text-primary">
              {selected.childName} · {selected.centerName}
            </p>
          </div>
        )}

        <ParentDateFilter
          date={dateFilter}
          childId={selected.studentProfileId}
          todayIso={dateKey(today)}
          dateLabel={t("filterDate")}
        />
      </div>

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
                      <span>{row.teacherName}</span>
                      <span>{formatDate(row.date, locale)}</span>
                      <span>{formatTimeRange(row.startTime, row.endTime, locale)}</span>
                      {row.roomName ? <span>{row.roomName}</span> : null}
                    </p>
                    {/* U2 — a replacement says where it came from. */}
                    {row.movedFrom ? (
                      <p className="mt-1 text-xs text-text-secondary">
                        {tSessions("movedFrom", {
                          date: formatDay(row.movedFrom.date, locale),
                          time: formatTime(row.movedFrom.startTime, locale),
                        })}
                      </p>
                    ) : null}
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
