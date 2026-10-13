import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { loadSessionReceiptView } from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { TeacherSessionPrintToolbar } from "@/app/[locale]/(print)/teacher/sessions/[id]/print/toolbar";
import { SessionPrintSheet } from "@/components/shared/session-print-sheet";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { closeSessionIfDayOver } from "@/lib/db/session-lifecycle";
import { sessionDisplayName } from "@/lib/session-label";
import { isWithinVisibilityWindow, visibilityWindowFloor } from "@/lib/db/visibility";
import { formatMoney } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";

/**
 * The staff print view of a session's receipt (R2) — `session.view`, the
 * same id scoping and data-visibility refusal as `/sessions/[id]` (a
 * cross-tenant or out-of-window id is "not found"), and the same
 * `center.profit.view` gate on the centre/teacher split as the on-screen
 * receipt. The sheet is the teacher print layout's own
 * (`SessionPrintSheet`), and the receipt inside it — totals, the close, the
 * "Changes during session" section — is `SessionReceipt` fed by
 * `loadSessionReceiptView`, so nothing about the receipt is forked.
 */
export default async function SessionPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "session.view");
  const { id } = await params;

  const db = scoped(ctx);
  // R2's lazy end-of-day close, on read.
  await closeSessionIfDayOver(prisma, ctx.center.id, id);
  const session = await db.sessions.findDetailById(id);
  if (!session || !isWithinVisibilityWindow(session.date, visibilityWindowFloor(ctx))) {
    notFound();
  }

  const locale = await getLocale();
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
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const className = sessionDisplayName(locale, session);

  return (
    <>
      <style>{`@page { size: A4; margin: 14mm; }`}</style>

      <TeacherSessionPrintToolbar
        title={className}
        hint={tSheet("hint")}
        printLabel={tSheet("print")}
        backLabel={tSheet("back")}
        backHref={ROUTES.centerSession(session.id)}
      />

      <SessionPrintSheet
        centerName={ctx.center.name}
        className={className}
        session={session}
        contextRows={[
          { label: tSheet("teacher"), value: fullName(session.teacher) },
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
        showProfit={ctxCan(ctx, "center.profit.view")}
        roster={roster}
        locale={locale}
        timeZone={timeZone}
      />
    </>
  );
}
