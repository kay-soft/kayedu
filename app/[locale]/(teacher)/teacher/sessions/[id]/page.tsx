import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { cancelOwnBookingAction } from "@/app/[locale]/(teacher)/teacher/approvals/actions";
import { SessionDescriptionForm } from "@/app/[locale]/(teacher)/teacher/sessions/[id]/description-form";
import { SessionReceipt } from "@/app/[locale]/(center)/sessions/[id]/session-receipt";
import { loadSessionReceiptView } from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { CancelBookingButton } from "@/components/center/cancel-booking-button";
import { PageHeader } from "@/components/shared/page-header";
import { SessionKindBadge } from "@/components/shared/session-kind-badge";
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
import { consecutiveAbsenceCount } from "@/lib/db/attendance";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { closeSessionIfDayOver, sessionTimeZone } from "@/lib/db/session-lifecycle";
import { deriveSessionDisplayStatus } from "@/lib/db/sessions";
import { sessionDisplayName, sessionKind } from "@/lib/session-label";
import { attendanceDisplay } from "@/lib/attendance-rules";
import { formatDate, formatDay, formatMoney, formatTime, formatTimeRange } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

const ATTENDANCE_BADGE = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "danger",
  // T5 — a live session's ABSENT row, or a drop-in's: not an absence.
  NOT_ARRIVED: "neutral",
} as const;

/**
 * A teacher's own session detail (spec §4.2 item 2): grade, roster/attendance
 * (read-only — marking attendance/payment stays a center-staff action),
 * absent count, earning + center earning (this is the teacher's own session,
 * so `showProfit` is unconditional — unlike the center's receipt, which gates
 * it on `center.profit.view`), print, and a description edit.
 *
 * The id resolves through `findDetailById` (centerId-scoped) and is then
 * re-checked against `teacherId` — a session belonging to another teacher at
 * the same center must 404 here exactly like a foreign center's id would.
 */
export default async function TeacherSessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getTenantContext("teacher");
  const { id } = await params;

  const db = scoped(ctx);
  const owned = await db.sessions.findById(id);
  if (!owned || owned.teacherId !== ctx.user.id) notFound();
  // R2's lazy end-of-day close, on read (lib/db/session-lifecycle.ts).
  await closeSessionIfDayOver(prisma, ctx.center.id, id);
  const session = await db.sessions.findDetailById(id);
  if (!session || session.teacherId !== ctx.user.id) notFound();

  const t = await getTranslations("TeacherSessions");
  const tAttendance = await getTranslations("Sessions.attendance");
  const tStatus = await getTranslations("Sessions.status");
  const tSessions = await getTranslations("Sessions");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  // D-14 — the session's own frozen timezone.
  const timeZone = sessionTimeZone(session, ctx.settings?.timezone ?? DEFAULT_TIMEZONE);
  const receipt = await loadSessionReceiptView(ctx.center.id, session);

  const closed = session.closedAt !== null;
  const roster = await Promise.all(
    session.attendees
      .filter((attendee) => attendee.studentProfileId)
      .map(async (attendee) => ({
        id: attendee.id,
        name: fullName(localName(attendee.studentProfile!, attendee.studentProfile!.user)),
        studentCode: attendee.studentProfile!.studentCode,
        // T5 — "Not arrived", never Absent, for a live ABSENT row or a drop-in's.
        status: attendanceDisplay(attendee, closed),
        isDropIn: attendee.isDropIn,
        // An absence streak is per class; a one-time session (R5) has none.
        consecutiveAbsences:
          attendanceDisplay(attendee, closed) === "ABSENT" && session.classGroupId
            ? await consecutiveAbsenceCount(
                prisma,
                ctx.center.id,
                session.classGroupId,
                attendee.studentProfileId!,
                session.date,
              )
            : 0,
      })),
  );

  const displayStatus = deriveSessionDisplayStatus(
    session,
    new Date(),
    timeZone,
  );
  // T7 (F6): students who booked this one session online and have not arrived.
  // A booking names the global User; its branch profile exists from confirmation on.
  const tBooked = await getTranslations("Sessions.booked");
  const confirmedBookings = await db.sessionBookings.listConfirmedForSession(session.id);
  const bookedProfiles =
    confirmedBookings.length > 0
      ? await db.students.search({
          where: { userId: { in: confirmedBookings.map((booking) => booking.studentId) } },
          take: confirmedBookings.length,
        })
      : [];
  const arrivedProfileIds = new Set(session.attendees.map((attendee) => attendee.studentProfileId));
  const bookingIdByUserId = new Map(confirmedBookings.map((booking) => [booking.studentId, booking.id]));
  const bookedNotArrived = bookedProfiles
    .filter((profile) => !arrivedProfileIds.has(profile.id))
    .map((profile) => ({
      bookingId: bookingIdByUserId.get(profile.userId)!,
      name: fullName(localName(profile, profile.user)),
      studentCode: profile.studentCode,
    }));
  // Cancelling is the same gate as confirming (`reservation.manage.own`); the
  // action pins the booking to a class this teacher teaches.
  const canCancelBooking =
    ctxCan(ctx, "reservation.manage.own") &&
    !closed &&
    displayStatus !== "CANCELLED" &&
    displayStatus !== "RESCHEDULED";
  const className = sessionDisplayName(locale, session);
  // A class session's grade is its class's; a one-time session's is its own (R5).
  const grade = session.classGroup ? session.classGroup.grade : session.grade;
  const absentCount = roster.filter((row) => row.status === "ABSENT").length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={className}
        description={t("detailSubtitle", {
          grade: catalogLabelWithSelection(locale, grade) ?? tCommon("none"),
          date: formatDate(session.date, locale),
        })}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SessionKindBadge kind={sessionKind(session)} />
            <Badge variant={STATUS_BADGE[displayStatus]}>{tStatus(displayStatus)}</Badge>
            <LinkButton href={ROUTES.teacherSessionPrint(session.id)}>
              {t("printAction")}
            </LinkButton>
            <LinkButton href={ROUTES.teacherSessions}>
              {t("backToList")}
            </LinkButton>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("roster.title")}</CardTitle>
              <CardDescription>
                {t("roster.description", { absent: absentCount })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {roster.length === 0 ? (
                <EmptyState compact icon={<Users />} title={t("roster.empty")} description={t("roster.emptyHint")} />
              ) : (
                <ul className="flex flex-col gap-2">
                  {roster.map((row) => (
                    <li
                      key={row.id}
                      className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text-primary">
                          {row.name}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                          <span dir="ltr">{row.studentCode}</span>
                          {row.isDropIn ? <span>{t("roster.dropIn")}</span> : null}
                        </p>
                        {row.status === "ABSENT" && row.consecutiveAbsences >= 2 ? (
                          <p className="mt-1 text-xs font-medium text-danger-fg">
                            {t("roster.consecutiveAbsentAlert", {
                              count: row.consecutiveAbsences,
                            })}
                          </p>
                        ) : null}
                      </div>
                      <Badge variant={ATTENDANCE_BADGE[row.status]}>
                        {tAttendance(row.status)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {bookedNotArrived.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{tBooked("notArrived", { count: bookedNotArrived.length })}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2">
                  {bookedNotArrived.map((student) => (
                    <li
                      key={student.bookingId}
                      className="flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-primary">{student.name}</p>
                          <p className="text-xs text-text-muted" dir="ltr">
                            {student.studentCode}
                          </p>
                        </div>
                        <Badge variant="info">{tBooked("badge")}</Badge>
                      </div>
                      {canCancelBooking ? (
                        <CancelBookingButton id={student.bookingId} action={cancelOwnBookingAction} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>{t("description.title")}</CardTitle>
              <CardDescription>
                {/* M10's edit deadline, as this branch set it (SYS: the copy used to say none existed). */}
                {ctx.settings?.teacherEditDeadlineHours
                  ? t("description.hintDeadline", { hours: ctx.settings.teacherEditDeadlineHours })
                  : t("description.hintNoDeadline")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SessionDescriptionForm
                sessionId={session.id}
                description={session.description ?? ""}
              />
            </CardContent>
          </Card>

        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("context.title")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.date")}</span>
                <span className="font-medium text-text-primary">
                  {formatDate(session.date, locale)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.time")}</span>
                <span className="font-medium tabular-nums text-text-primary">
                  {formatTimeRange(session.startTime, session.endTime, locale)}
                </span>
              </div>
              {/* U2 — a replacement says where it came from. */}
              {session.rescheduledFrom ? (
                <div className="flex justify-between gap-3">
                  <span className="text-text-secondary">{tSessions("fields.movedFrom")}</span>
                  <span className="min-w-0 text-end font-medium break-words text-text-primary">
                    {tSessions("slot", {
                      date: formatDay(session.rescheduledFrom.date, locale),
                      time: formatTime(session.rescheduledFrom.startTime, locale),
                    })}
                  </span>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.room")}</span>
                <span className="font-medium text-text-primary">
                  {session.room?.name ?? tCommon("none")}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.grade")}</span>
                <span className="font-medium text-text-primary">
                  {catalogLabelWithSelection(locale, grade) ?? tCommon("none")}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.price")}</span>
                <span className="font-medium tabular-nums text-text-primary">
                  {formatMoney(session.priceSnapshot, locale)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("receipt.title")}</CardTitle>
              <CardDescription>{t("receipt.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              {/* This is the teacher's own session — their earning and the
                  center's cut on it are shown here (spec §4.2 item 2) under
                  the teacher's own `analytics.own.view` (TEACHER baseline),
                  never the centre staff's broader center.profit.view. SEC-15:
                  a centre that revokes the cell hides the money. */}
              <SessionReceipt
                totals={receipt.totals}
                showProfit={ctxCan(ctx, "analytics.own.view")}
                locale={locale}
                timeZone={timeZone}
                closure={receipt.closure}
                changes={receipt.changes}
                voids={receipt.voids}
                refunds={receipt.refunds}
                unpaid={receipt.unpaid}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
