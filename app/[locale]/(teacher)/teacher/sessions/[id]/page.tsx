import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { SessionDescriptionForm } from "@/app/[locale]/(teacher)/teacher/sessions/[id]/description-form";
import { SessionReceipt } from "@/app/[locale]/(center)/sessions/[id]/session-receipt";
import { loadSessionReceiptView } from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { PageHeader } from "@/components/shared/page-header";
import { FormMessage } from "@/components/shared/form-message";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTenantContext } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { consecutiveAbsenceCount } from "@/lib/db/attendance";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { closeSessionIfDayOver } from "@/lib/db/session-lifecycle";
import { deriveSessionDisplayStatus, sessionDisplayName } from "@/lib/db/sessions";
import { formatDate, formatMoney, formatTimeRange } from "@/lib/format";
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
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const timeZone = ctx.settings?.timezone ?? DEFAULT_TIMEZONE;
  const receipt = await loadSessionReceiptView(ctx.center.id, session);

  const roster = await Promise.all(
    session.attendees
      .filter((attendee) => attendee.studentProfileId)
      .map(async (attendee) => ({
        id: attendee.id,
        name: fullName(localName(attendee.studentProfile!, attendee.studentProfile!.user)),
        studentCode: attendee.studentProfile!.studentCode,
        status: attendee.attendanceStatus,
        isDropIn: attendee.isDropIn,
        consecutiveAbsences:
          attendee.attendanceStatus === "ABSENT"
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
  const className = sessionDisplayName(locale, { classGroup: session.classGroup });
  const absentCount = roster.filter((row) => row.status === "ABSENT").length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={className}
        description={t("detailSubtitle", {
          grade: catalogLabelWithSelection(locale, session.classGroup.grade) ?? tCommon("none"),
          date: formatDate(session.date, locale),
        })}
        action={
          <div className="flex flex-wrap items-center gap-2">
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
                          <p className="mt-1 text-xs font-medium text-danger">
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

          <Card>
            <CardHeader>
              <CardTitle>{t("description.title")}</CardTitle>
              <CardDescription>{t("description.hint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <SessionDescriptionForm
                sessionId={session.id}
                description={session.description ?? ""}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("uploads.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <FormMessage tone="info">{t("uploads.comingSoon")}</FormMessage>
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
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.room")}</span>
                <span className="font-medium text-text-primary">
                  {session.room?.name ?? tCommon("none")}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.grade")}</span>
                <span className="font-medium text-text-primary">
                  {session.classGroup.grade ? catalogLabelWithSelection(locale, session.classGroup.grade) : tCommon("none")}
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
                  center's cut on it are always shown here (spec §4.2 item 2),
                  unlike the center staff receipt which gates on
                  center.profit.view (a different, broader permission). */}
              <SessionReceipt
                totals={receipt.totals}
                showProfit
                locale={locale}
                timeZone={timeZone}
                closure={receipt.closure}
                changes={receipt.changes}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
