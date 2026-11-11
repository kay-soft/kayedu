import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, Clock, Lock } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { loadSessionReceiptView } from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { SessionReceipt } from "@/app/[locale]/(center)/sessions/[id]/session-receipt";
import {
  workspaceCheckInAction,
  workspaceCloseSessionAction,
  workspaceRecordPaymentAction,
  workspaceRefundPaymentAction,
  workspaceSetAttendanceAction,
  workspaceVoidPaymentAction,
} from "@/app/[locale]/(teacher)/teacher/workspaces/session-actions";
import {
  WorkspaceEndSessionButton,
  WorkspaceSessionRoster,
  type WorkspaceSessionActions,
} from "@/components/teacher/workspaces/workspace-session-roster";
import { DetailCard, DetailLayout } from "@/components/shared/detail-layout";
import { DetailRow } from "@/components/shared/field";
import { LinkButton } from "@/components/shared/link-button";
import { SessionKindBadge } from "@/components/shared/session-kind-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getWorkspaceContext, workspaceOffersWrites } from "@/lib/auth/workspace-context";
import { prisma } from "@/lib/db/client";
import { closeSessionIfDayOver, sessionTimeZone } from "@/lib/db/session-lifecycle";
import { deriveSessionDisplayStatus } from "@/lib/db/sessions";
import { teacherPortalHistoryFloor } from "@/lib/db/teacher-portal";
import { workspaceSessionDetail, workspaceSessionRoster } from "@/lib/db/workspace-attendance";
import { formatDate, formatDateTime, formatMoney, formatTimeRange } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { centreTimeZone } from "@/lib/scheduling";
import { sessionDisplayName, sessionKind } from "@/lib/session-label";

/** The teacher's own six actions (W8d: the roster takes its actions from the page). */
const TEACHER_ACTIONS: WorkspaceSessionActions = {
  checkIn: workspaceCheckInAction,
  setAttendance: workspaceSetAttendanceAction,
  record: workspaceRecordPaymentAction,
  voidPayment: workspaceVoidPaymentAction,
  refundPayment: workspaceRefundPaymentAction,
  close: workspaceCloseSessionAction,
};

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("WorkspaceSession");
  return { title: t("metaTitle") };
}

/**
 * One workspace session (W8c, D-W40 item 9; docs/04 §11.37): the roster with
 * check-in, corrections and the money, **End session**, and the receipt —
 * the branches' own `SessionReceipt` over `loadSessionReceiptView`, with the
 * split shown (collected, the teacher's 100%, the centre's 0 EGP) and the
 * Present / Late / Absent counts. Resolved for the workspace's **owner** only
 * (`getWorkspaceContext`); a session of another workspace, or one older than
 * the teacher's own window (`teacherPortalHistoryFloor`), is not-found. The
 * end-of-day lazy close runs on read (R2) — it is the system's close, so it
 * runs whether or not the workspace takes writes (D-W40). No settlement verb
 * exists here (D-W24).
 */
export default async function WorkspaceSessionPage({ params }: { params: Promise<{ id: string; sessionId: string }> }) {
  const { id, sessionId } = await params;
  const ctx = await getWorkspaceContext(id);
  if (!ctx) notFound();
  const centerId = ctx.center.id;
  await closeSessionIfDayOver(prisma, centerId, sessionId);
  const session = await workspaceSessionDetail(prisma, centerId, sessionId);
  const floor = teacherPortalHistoryFloor(ctx);
  if (!session || (floor && session.date < floor)) notFound();

  const [t, tStatus, tSessions, tClosure, locale] = await Promise.all([
    getTranslations("WorkspaceSession"),
    getTranslations("Sessions.status"),
    getTranslations("Sessions"),
    getTranslations("Sessions.closure"),
    getLocale(),
  ]);
  const timeZone = sessionTimeZone(session, centreTimeZone(ctx.settings));
  const displayStatus = deriveSessionDisplayStatus(session, new Date(), timeZone);
  const closed = session.closedAt !== null;
  const readOnly = closed || displayStatus === "CANCELLED" || displayStatus === "RESCHEDULED";
  const writable = workspaceOffersWrites(ctx);
  const [rows, receipt] = await Promise.all([
    workspaceSessionRoster(prisma, centerId, session, readOnly),
    loadSessionReceiptView(centerId, session),
  ]);
  const canEnd = writable && !readOnly && displayStatus === "LIVE";
  const priceLabel = formatMoney(session.priceSnapshot, locale);

  const receiptCard = (
    <DetailCard title={t("receiptTitle")} description={t("receiptDescription")}>
      <SessionReceipt
        totals={receipt.totals}
        showProfit
        locale={locale}
        timeZone={timeZone}
        closure={receipt.closure}
        changes={receipt.changes}
        voids={receipt.voids}
        refunds={receipt.refunds}
        unpaid={receipt.unpaid}
        showOpenNote={!readOnly}
      />
    </DetailCard>
  );

  return (
    <div className="flex flex-col gap-6">
      {/* The workspace layout owns the page's h1 (PageHeader); a section is an h2 card, as the class page. */}
      <Card>
        <CardContent className="flex flex-col gap-4">
          <LinkButton href={ROUTES.teacherWorkspaceSessions(id)} className="w-full sm:w-fit">
            <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
            {t("back")}
          </LinkButton>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-2">
              <h2 className="break-words text-lg font-semibold text-text-primary">{sessionDisplayName(locale, session)}</h2>
              <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                <SessionKindBadge kind={sessionKind(session)} />
                <Badge variant={STATUS_BADGE[displayStatus]}>{tStatus(displayStatus)}</Badge>
                <span>{formatDate(session.date, locale)}</span>
                <span className="inline-flex items-center gap-1.5 tabular-nums">
                  <Clock className="size-4 text-text-muted" aria-hidden />
                  {formatTimeRange(session.startTime, session.endTime, locale)}
                </span>
              </div>
              {displayStatus === "RESCHEDULED" && session.rescheduledToId ? (
                <LinkButton href={ROUTES.teacherWorkspaceSession(id, session.rescheduledToId)} className="w-full sm:w-fit">
                  {tSessions("lifecycle.viewNewSession")}
                </LinkButton>
              ) : null}
            </div>
            {canEnd ? (
              <div className="flex flex-col gap-2 sm:items-end">
                <WorkspaceEndSessionButton workspaceId={id} sessionId={session.id} closeAction={TEACHER_ACTIONS.close} />
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {receipt.closure ? (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-border bg-surface-subtle px-4 py-3 text-sm">
          <Lock className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium text-text-primary">
              {receipt.closure.closeMode === "AUTO"
                ? tClosure("closedAuto", { time: formatDateTime(receipt.closure.closedAt, locale, timeZone) })
                : receipt.closure.closedByName
                  ? tClosure("closedManual", {
                      time: formatDateTime(receipt.closure.closedAt, locale, timeZone),
                      name: receipt.closure.closedByName,
                    })
                  : tClosure("closedManualUnknown", { time: formatDateTime(receipt.closure.closedAt, locale, timeZone) })}
            </p>
            <p className="text-text-secondary">{tClosure("locked")}</p>
          </div>
        </div>
      ) : canEnd ? (
        <p className="text-xs text-text-muted">{tSessions("endSession.hint")}</p>
      ) : null}

      <DetailLayout
        main={
          <DetailCard
            title={t("rosterTitle")}
            description={session.classGroupId ? t("rosterDescription") : t("oneTimeNote")}
          >
            <WorkspaceSessionRoster
              workspaceId={id}
              sessionId={session.id}
              rows={rows}
              priceLabel={priceLabel}
              writable={writable}
              readOnly={readOnly}
              actions={TEACHER_ACTIONS}
            />
          </DetailCard>
        }
        side={
          <>
            {closed ? receiptCard : null}
            <DetailCard title={t("detailsTitle")} contentClassName="gap-0">
              <DetailRow stacked label={tSessions("fields.date")} value={formatDate(session.date, locale)} />
              <DetailRow stacked label={tSessions("fields.time")} value={formatTimeRange(session.startTime, session.endTime, locale)} />
              <DetailRow stacked label={tSessions("fields.status")} value={tStatus(displayStatus)} />
              <DetailRow stacked label={tSessions("fields.price")} value={priceLabel} />
            </DetailCard>
            {closed ? null : receiptCard}
          </>
        }
      />
    </div>
  );
}
