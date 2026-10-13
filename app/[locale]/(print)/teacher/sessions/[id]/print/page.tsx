import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { loadSessionReceiptView } from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { TeacherSessionPrintToolbar } from "@/app/[locale]/(print)/teacher/sessions/[id]/print/toolbar";
import { SessionPrintSheet } from "@/components/shared/session-print-sheet";
import { getTenantContext } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { closeSessionIfDayOver } from "@/lib/db/session-lifecycle";
import { sessionDisplayName } from "@/lib/session-label";
import { formatMoney } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";

/**
 * "Print" for a teacher's own session (spec §4.2 item 2) — a simple A4 sheet:
 * grade, roster with attendance, and the receipt with the earning/center-
 * earning split. Same ownership check as the on-screen detail page: a
 * session id that resolves to another teacher (even at this same center) is
 * not found here either. The sheet itself is shared with the staff print
 * route (`components/shared/session-print-sheet.tsx`, R2).
 */
export default async function TeacherSessionPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getTenantContext("teacher");
  const { id } = await params;

  const db = scoped(ctx);
  const owned = await db.sessions.findById(id);
  if (!owned || owned.teacherId !== ctx.user.id) notFound();
  // R2's lazy end-of-day close, on read.
  await closeSessionIfDayOver(prisma, ctx.center.id, id);
  const session = await db.sessions.findDetailById(id);
  if (!session || session.teacherId !== ctx.user.id) notFound();

  const locale = await getLocale();
  const tPrint = await getTranslations("TeacherSessions.print");
  const tSheet = await getTranslations("SessionPrint");
  const tCommon = await getTranslations("Settings.common");
  const timeZone = ctx.settings?.timezone ?? DEFAULT_TIMEZONE;

  const receipt = await loadSessionReceiptView(ctx.center.id, session);
  const roster = session.attendees
    .filter((attendee) => attendee.studentProfileId)
    .map((attendee) => ({
      id: attendee.id,
      name: fullName(localName(attendee.studentProfile!, attendee.studentProfile!.user)),
      studentCode: attendee.studentProfile!.studentCode,
      status: attendee.attendanceStatus,
    }));

  const className = sessionDisplayName(locale, session);

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

      <SessionPrintSheet
        centerName={ctx.center.name}
        className={className}
        session={session}
        contextRows={[
          {
            label: tSheet("grade"),
            value:
              // A one-time session (R5) carries its own optional grade.
              catalogLabelWithSelection(locale, session.classGroup ? session.classGroup.grade : session.grade) ??
              tCommon("none"),
          },
          { label: tSheet("room"), value: session.room?.name ?? tCommon("none") },
          { label: tSheet("price"), value: formatMoney(session.priceSnapshot, locale) },
        ]}
        receipt={receipt}
        // The teacher's own session — their earning and the centre's cut on
        // it are always shown (spec §4.2 item 2), as on the detail page.
        showProfit
        roster={roster}
        locale={locale}
        timeZone={timeZone}
      />
    </>
  );
}
