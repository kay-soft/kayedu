import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { TeacherSessionPrintToolbar } from "@/app/[locale]/(print)/teacher/sessions/[id]/print/toolbar";
import { DetailRow } from "@/components/shared/field";
import { getTenantContext } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import { sessionReceiptTotals } from "@/lib/db/payments";
import { scoped } from "@/lib/db/scoped";
import { sessionDisplayName } from "@/lib/db/sessions";
import { formatDate, formatMoney } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";

/**
 * "Print" for a teacher's own session (spec §4.2 item 2) — a simple A4 sheet:
 * grade, roster with attendance, and the earning/center-earning split. Same
 * ownership check as the on-screen detail page: a session id that resolves
 * to another teacher (even at this same center) is not found here either.
 */
export default async function TeacherSessionPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getTenantContext("teacher");
  const { id } = await params;

  const db = scoped(ctx);
  const session = await db.sessions.findDetailById(id);
  if (!session || session.teacherId !== ctx.user.id) notFound();

  const locale = await getLocale();
  const t = await getTranslations("TeacherSessions");
  const tPrint = await getTranslations("TeacherSessions.print");
  const tAttendance = await getTranslations("Sessions.attendance");
  const tCommon = await getTranslations("Settings.common");

  const totals = await sessionReceiptTotals(prisma, ctx.center.id, session.id);
  const roster = session.attendees
    .filter((attendee) => attendee.studentProfileId)
    .map((attendee) => ({
      id: attendee.id,
      name: fullName(localName(attendee.studentProfile!, attendee.studentProfile!.user)),
      studentCode: attendee.studentProfile!.studentCode,
      status: attendee.attendanceStatus,
    }));

  const className = sessionDisplayName({ classGroup: session.classGroup });

  return (
    <>
      <style>{`@page { size: A4; margin: 14mm; }`}</style>

      <TeacherSessionPrintToolbar
        title={className}
        hint={tPrint("hint")}
        printLabel={tPrint("print")}
        backLabel={tPrint("back")}
        backHref={ROUTES.teacherSession(session.id)}
      />

      <div className="mx-auto w-full max-w-3xl p-4 sm:p-8 print:max-w-none print:p-0">
        <header className="flex flex-col gap-2 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs text-text-muted">{ctx.center.name}</p>
            <h2 className="text-xl font-bold text-text-primary">{className}</h2>
            <p className="mt-1 text-sm text-text-secondary" dir="ltr">
              {formatDate(session.date, locale)} · {session.startTime}–{session.endTime}
            </p>
          </div>
          <p className="text-xs text-text-muted">
            {tPrint("printedOn", { date: formatDate(new Date(), locale) })}
          </p>
        </header>

        <section className="mt-6">
          <h3 className="text-sm font-semibold text-text-primary">{t("context.title")}</h3>
          <div className="mt-2">
            <DetailRow label={t("fields.grade")} value={session.classGroup.grade?.name ?? tCommon("none")} />
            <DetailRow label={t("fields.room")} value={session.room?.name ?? tCommon("none")} />
            <DetailRow label={t("fields.price")} value={formatMoney(session.priceSnapshot, locale)} />
          </div>
        </section>

        <section className="mt-6">
          <h3 className="text-sm font-semibold text-text-primary">{t("receipt.title")}</h3>
          <div className="mt-2">
            <DetailRow label={tPrint("collected")} value={formatMoney(totals.collected, locale)} />
            <DetailRow label={tPrint("centerShare")} value={formatMoney(totals.centerShare, locale)} />
            <DetailRow label={tPrint("teacherShare")} value={formatMoney(totals.teacherShare, locale)} />
            <DetailRow
              label={tPrint("attendanceSummary")}
              value={tPrint("attendanceCounts", {
                present: totals.presentCount,
                late: totals.lateCount,
                absent: totals.absentCount,
                excused: totals.excusedCount,
              })}
            />
          </div>
        </section>

        <section className="mt-6 break-inside-avoid">
          <h3 className="text-sm font-semibold text-text-primary">{t("roster.title")}</h3>
          {roster.length === 0 ? (
            <p className="mt-2 text-sm text-text-muted">{t("roster.empty")}</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {roster.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 border-b border-border-subtle py-2 text-sm last:border-0"
                >
                  <span className="font-medium text-text-primary">{row.name}</span>
                  <span className="text-text-secondary" dir="ltr">
                    {row.studentCode}
                  </span>
                  <span className="text-text-secondary">{tAttendance(row.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
