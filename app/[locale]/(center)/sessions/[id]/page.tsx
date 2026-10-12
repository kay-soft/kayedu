import { notFound } from "next/navigation";
import { Lock, Printer } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { AddAttendeePanel, type AttendeeCandidate } from "@/app/[locale]/(center)/sessions/[id]/add-attendee-panel";
import { EndSessionButton } from "@/app/[locale]/(center)/sessions/[id]/end-session-button";
import { loadSessionReceiptView } from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { SessionLifecycleActions } from "@/app/[locale]/(center)/sessions/[id]/session-lifecycle-actions";
import { SessionReceipt } from "@/app/[locale]/(center)/sessions/[id]/session-receipt";
import { SessionRoster, type RosterRowData } from "@/app/[locale]/(center)/sessions/[id]/session-roster";
import { SessionSettlementAction } from "@/app/[locale]/(center)/settlements/session-settlement-action";
import { searchAddAttendeeCandidatesAction } from "@/app/[locale]/(center)/sessions/actions";
import { TypeAheadSearch } from "@/components/center/type-ahead-search";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { consecutiveAbsenceCount } from "@/lib/db/attendance";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { closeSessionIfDayOver } from "@/lib/db/session-lifecycle";
import { isWithinVisibilityWindow, visibilityWindowFloor } from "@/lib/db/visibility";
import { deriveSessionDisplayStatus, sessionDisplayName } from "@/lib/db/sessions";
import { studentSearchWhere } from "@/lib/db/students";
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatTimeRange,
} from "@/lib/format";
import { effectiveCapacity } from "@/lib/rooms";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { LinkButton } from "@/components/shared/link-button";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";

const MAX_CANDIDATES = 8;

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

/**
 * One session's roster, attendance and receipt (spec §4.1 item 7). The id in
 * the URL resolves through the scoped helper, so a session id from another
 * center resolves to "not found", never a row (docs/02 §5).
 */
export default async function SessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "session.view");

  const { id } = await params;
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  const db = scoped(ctx);
  // R2's lazy end-of-day close, on read: a session whose day ended without
  // anyone pressing "End session" is closed (AUTO) before it renders, so the
  // page never offers a control the server would refuse.
  await closeSessionIfDayOver(prisma, ctx.center.id, id);
  const session = await db.sessions.findDetailById(id);
  // A session older than the data-visibility window (M19) refuses the same
  // way a cross-tenant id does — "not found", not a visible-but-locked page —
  // mirroring the receptionist profit-denial shape (spec §7 criterion 9) at
  // the direct-URL level this milestone's acceptance criteria call out.
  if (!session || !isWithinVisibilityWindow(session.date, visibilityWindowFloor(ctx))) {
    notFound();
  }

  const t = await getTranslations("Sessions");
  const tStatus = await getTranslations("Sessions.status");
  const tCommon = await getTranslations("Settings.common");
  const tSettlementStatus = await getTranslations("Settlements.status");
  const locale = await getLocale();

  const timeZone = ctx.settings?.timezone ?? DEFAULT_TIMEZONE;
  const canReschedule = ctxCan(ctx, "session.manage");
  const [enrollments, receipt, existingSettlement, paymentMethods, rooms, roomLinks] = await Promise.all([
    db.enrollments.listForClass(session.classGroupId),
    loadSessionReceiptView(ctx.center.id, session),
    ctxCan(ctx, "settlement.manage")
      ? prisma.settlement.findFirst({ where: { centerId: ctx.center.id, sessionId: session.id } })
      : Promise.resolve(null),
    // R1: only active methods are offered; recorded payments show their own
    // frozen label regardless of what happens to the method afterwards.
    db.paymentMethods.listActive(),
    // R3: the room pickers in reschedule / "Rooms" — only for who can use them.
    canReschedule ? db.rooms.list() : Promise.resolve([]),
    canReschedule ? db.roomLinks.list() : Promise.resolve([]),
  ]);
  // R3 — this session's own room set (primary + extras) and what it seats.
  const sessionRooms = session.room
    ? [session.room, ...session.extraRooms.map((extra) => extra.room)]
    : [];
  const sessionSeats = effectiveCapacity(sessionRooms);

  const activeEnrollments = enrollments.filter((e) => e.status === "ACTIVE");
  const attendeeByStudentId = new Map(
    session.attendees
      .filter((a) => a.studentProfileId)
      .map((a) => [a.studentProfileId as string, a]),
  );

  const rosterMap = new Map<string, RosterRowData>();

  const toRow = (
    studentProfileId: string,
    profile: { firstName: string | null; lastName: string | null; studentCode: string; user: { firstName: string; lastName: string } },
  ): RosterRowData => {
    const attendee = attendeeByStudentId.get(studentProfileId);
    const activePayment = attendee?.payments.find((p) => !p.voided) ?? null;
    return {
      studentProfileId,
      attendeeId: attendee?.id ?? null,
      name: fullName(localName(profile, profile.user)),
      studentCode: profile.studentCode,
      isDropIn: attendee?.isDropIn ?? false,
      status: attendee?.attendanceStatus ?? null,
      payment: activePayment
        ? {
            id: activePayment.id,
            amount: activePayment.amount,
            methodLabel: activePayment.methodLabelSnapshot,
            refunded: activePayment.refunded,
          }
        : null,
      consecutiveAbsences: 0,
    };
  };

  for (const enrollment of activeEnrollments) {
    rosterMap.set(
      enrollment.studentProfileId,
      toRow(enrollment.studentProfileId, enrollment.studentProfile),
    );
  }
  for (const attendee of session.attendees) {
    if (!attendee.studentProfileId || rosterMap.has(attendee.studentProfileId)) continue;
    rosterMap.set(attendee.studentProfileId, toRow(attendee.studentProfileId, attendee.studentProfile!));
  }

  const roster = [...rosterMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  await Promise.all(
    roster
      .filter((row) => row.status === "ABSENT")
      .map(async (row) => {
        row.consecutiveAbsences = await consecutiveAbsenceCount(
          prisma,
          ctx.center.id,
          session.classGroupId,
          row.studentProfileId,
          session.date,
        );
      }),
  );

  const rosterStudentIds = new Set(roster.map((row) => row.studentProfileId));
  const candidates: AttendeeCandidate[] =
    query.length > 0
      ? (
          await db.students.search({
            where: {
              ...studentSearchWhere(query),
              active: true,
              ...(rosterStudentIds.size > 0
                ? { NOT: { id: { in: [...rosterStudentIds] } } }
                : {}),
            },
            take: MAX_CANDIDATES,
          })
        ).map((profile) => ({
          studentProfileId: profile.id,
          name: fullName(localName(profile, profile.user)),
          studentCode: profile.studentCode,
        }))
      : [];

  const displayStatus = deriveSessionDisplayStatus(session, new Date(), timeZone);
  const teacherName = fullName(session.teacher);
  const className = sessionDisplayName(locale, { classGroup: session.classGroup });
  // A cancelled session never happened; a rescheduled one moved to its
  // replacement (M15); a closed one is a final record (R2). None accepts
  // attendance or payment changes, and the server actions refuse every one
  // by direct call, not just by hiding controls here.
  const closed = session.closedAt !== null;
  const rosterReadOnly =
    closed || displayStatus === "CANCELLED" || displayStatus === "RESCHEDULED";
  const canEnd = !rosterReadOnly && displayStatus === "LIVE" && ctxCan(ctx, "session.close");
  const tClosure = await getTranslations("Sessions.closure");
  const tEnd = await getTranslations("Sessions.endSession");

  const receiptCard = (
    <Card>
      <CardHeader>
        <CardTitle>{t("receipt.title")}</CardTitle>
        <CardDescription>{t("receipt.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SessionReceipt
          totals={receipt.totals}
          showProfit={ctxCan(ctx, "center.profit.view")}
          locale={locale}
          timeZone={timeZone}
          closure={receipt.closure}
          changes={receipt.changes}
          showOpenNote={!closed && !rosterReadOnly}
        />
        {closed ? (
          <LinkButton href={ROUTES.centerSessionPrint(session.id)} className="w-full sm:w-fit">
            <Printer className="size-4" aria-hidden />
            {t("receipt.print")}
          </LinkButton>
        ) : null}
        {ctxCan(ctx, "settlement.manage") ? (
          <div className="border-t border-border-subtle pt-4">
            {existingSettlement ? (
              <p className="text-sm text-text-secondary">
                {t("settlement.status", {
                  status: tSettlementStatus(existingSettlement.status),
                })}
              </p>
            ) : closed ? (
              <SessionSettlementAction sessionId={session.id} />
            ) : (
              <p className="text-sm text-text-muted">{t("settlement.notClosedHint")}</p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={className}
        description={t("detailSubtitle", {
          teacher: teacherName,
          date: formatDate(session.date, locale),
        })}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_BADGE[displayStatus]}>{tStatus(displayStatus)}</Badge>
            {displayStatus === "RESCHEDULED" && session.rescheduledToId ? (
              <LinkButton href={ROUTES.centerSession(session.rescheduledToId)}>
                {t("lifecycle.viewNewSession")}
              </LinkButton>
            ) : null}
            <LinkButton href={ROUTES.centerSessions}>
              {t("backToList")}
            </LinkButton>
          </div>
        }
      />

      {receipt.closure ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-border bg-surface-subtle px-4 py-3 text-sm"
        >
          <Lock className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium text-text-primary">
              {receipt.closure.closeMode === "AUTO"
                ? tClosure("closedAuto", {
                    time: formatDateTime(receipt.closure.closedAt, locale, timeZone),
                  })
                : receipt.closure.closedByName
                  ? tClosure("closedManual", {
                      time: formatDateTime(receipt.closure.closedAt, locale, timeZone),
                      name: receipt.closure.closedByName,
                    })
                  : tClosure("closedManualUnknown", {
                      time: formatDateTime(receipt.closure.closedAt, locale, timeZone),
                    })}
            </p>
            <p className="text-text-secondary">{tClosure("locked")}</p>
          </div>
        </div>
      ) : canEnd ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-text-secondary">{tEnd("hint")}</p>
          <div className="flex flex-col gap-2 sm:items-end">
            <EndSessionButton sessionId={session.id} />
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <Card>
          <CardHeader>
            <CardTitle>{t("roster.title")}</CardTitle>
            <CardDescription>{t("roster.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <SessionRoster
              sessionId={session.id}
              rows={roster}
              canRecord={ctxCan(ctx, "attendance.record")}
              canCorrect={ctxCan(ctx, "attendance.correct")}
              canRecordPayment={ctxCan(ctx, "payment.record")}
              canVoid={ctxCan(ctx, "payment.void")}
              canRefund={ctxCan(ctx, "payment.refund")}
              paymentMethods={paymentMethods.map(({ id, name }) => ({ id, name }))}
              readOnly={rosterReadOnly}
            />

            {rosterReadOnly ? null : (
              <div className="border-t border-border pt-4">
                <p className="mb-2 text-sm font-medium text-text-primary">
                  {t("addAttendee.title")}
                </p>
                <TypeAheadSearch
                  value={query}
                  label={t("addAttendee.searchLabel")}
                  placeholder={t("addAttendee.searchPlaceholder")}
                  submitLabel={t("addAttendee.searchSubmit")}
                  search={searchAddAttendeeCandidatesAction.bind(null, session.id)}
                />
                <div className="mt-4">
                  <AddAttendeePanel
                    sessionId={session.id}
                    candidates={candidates}
                    hasQuery={query.length > 0}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          {/* Once closed, the receipt is the record — it leads the column. */}
          {closed ? receiptCard : null}
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
                <span className="text-end font-medium text-text-primary">
                  {sessionRooms.map((room) => room.name).join(" + ") || tCommon("none")}
                </span>
              </div>
              {sessionRooms.length > 0 ? (
                <div className="flex justify-between gap-3">
                  <span className="text-text-secondary">{t("fields.seats")}</span>
                  <span className="font-medium tabular-nums text-text-primary">
                    {sessionSeats > 0
                      ? formatNumber(sessionSeats, locale)
                      : t("fields.seatsUnlimited")}
                  </span>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.price")}</span>
                <span className="font-medium tabular-nums text-text-primary">
                  {formatMoney(session.priceSnapshot, locale)}
                </span>
              </div>
              <div className="border-t border-border pt-3">
                <SessionLifecycleActions
                  sessionId={session.id}
                  date={session.date.toISOString().slice(0, 10)}
                  startTime={session.startTime}
                  endTime={session.endTime}
                  locked={rosterReadOnly}
                  canCancel={ctxCan(ctx, "session.cancel")}
                  canReschedule={canReschedule}
                  roomSet={{
                    rooms: rooms.map((room) => ({
                      id: room.id,
                      name: room.name,
                      capacity: room.capacity,
                      active: room.active,
                    })),
                    roomLinks,
                    roomId: session.roomId ?? "",
                    extraRoomIds: session.roomId
                      ? session.extraRooms.map((extra) => extra.roomId)
                      : [],
                    noneLabel: tCommon("none"),
                  }}
                />
              </div>
            </CardContent>
          </Card>

          {closed ? null : receiptCard}
        </div>
      </div>
    </div>
  );
}
