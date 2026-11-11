import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  assistantWorkspaceCheckInAction,
  assistantWorkspaceCloseSessionAction,
  assistantWorkspaceRecordPaymentAction,
  assistantWorkspaceRefundPaymentAction,
  assistantWorkspaceSetAttendanceAction,
  assistantWorkspaceVoidPaymentAction,
} from "@/app/[locale]/(assistant)/assistant/[teacherId]/workspaces/actions";
import {
  WorkspaceEndSessionButton,
  WorkspaceSessionRoster,
  type WorkspaceSessionActions,
} from "@/components/teacher/workspaces/workspace-session-roster";
import { DetailCard, DetailLayout } from "@/components/shared/detail-layout";
import { DetailRow } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { SessionKindBadge } from "@/components/shared/session-kind-badge";
import { Badge } from "@/components/ui/badge";
import { getAssistantScope, scopeCan, scopeWorkspace } from "@/lib/auth/assistant-context";
import { prisma } from "@/lib/db/client";
import { closeSessionIfDayOver, sessionTimeZone } from "@/lib/db/session-lifecycle";
import { deriveSessionDisplayStatus } from "@/lib/db/sessions";
import { workspaceSessionDetail, workspaceSessionRoster } from "@/lib/db/workspace-attendance";
import { formatDate, formatMoney, formatTimeRange } from "@/lib/format";
import { ROUTES, assessmentRoutes } from "@/lib/routes";
import { sessionDisplayName, sessionKind } from "@/lib/session-label";

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

/** The assistant's six actions — each re-resolves the link and the workspace on the server. */
const ASSISTANT_ACTIONS: WorkspaceSessionActions = {
  checkIn: assistantWorkspaceCheckInAction,
  setAttendance: assistantWorkspaceSetAttendanceAction,
  record: assistantWorkspaceRecordPaymentAction,
  voidPayment: assistantWorkspaceVoidPaymentAction,
  refundPayment: assistantWorkspaceRefundPaymentAction,
  close: assistantWorkspaceCloseSessionAction,
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("WorkspaceSession");
  return { title: t("metaTitle") };
}

/**
 * One workspace session, for the teacher's assistant (W8d, D-W41 items 9, 10):
 * the W8c roster with **Check in**, corrections and **End session** under
 * `checkin.workspace`, and **Record payment**, **Void** and **Refund** under
 * `payments.workspace` — the same component as the teacher's, posting to the
 * assistant's actions. Read-only otherwise (`classes.view` alone), and when
 * the workspace is archived. Phones only under `students.phones`. A session
 * before the assistant's floor (the teacher's `teacherHistoryDays`) or of
 * another workspace is a 404. **No receipt, split or settlement** here: the
 * money summary is the teacher's (Earnings, Full only). The lazy end-of-day
 * close runs on read, as on the teacher's page — the system's close, not the
 * assistant's.
 */
export default async function AssistantWorkspaceSessionPage({
  params,
}: {
  params: Promise<{ teacherId: string; id: string; sessionId: string }>;
}) {
  const { teacherId, id, sessionId } = await params;
  const scope = await getAssistantScope(teacherId);
  if (!scope) notFound();
  const workspace = scopeWorkspace(scope, id);
  if (!workspace) notFound();
  const centerId = workspace.centerId;
  await closeSessionIfDayOver(prisma, centerId, sessionId);
  const session = await workspaceSessionDetail(prisma, centerId, sessionId);
  if (!session || (workspace.floor && session.date < workspace.floor)) notFound();

  const [t, tAssistant, tStatus, tSessions, locale] = await Promise.all([
    getTranslations("WorkspaceSession"),
    getTranslations("Assistants.work.workspaces"),
    getTranslations("Sessions.status"),
    getTranslations("Sessions"),
    getLocale(),
  ]);
  const timeZone = sessionTimeZone(session, workspace.zone);
  const displayStatus = deriveSessionDisplayStatus(session, new Date(), timeZone);
  const readOnly = session.closedAt !== null || displayStatus === "CANCELLED" || displayStatus === "RESCHEDULED";
  // The teacher is premium (the link is effective); archived = read-only. The server decides anyway.
  const writable = workspace.archivedAt === null;
  const canCheckIn = scopeCan(scope, "checkin.workspace", centerId);
  const canPay = scopeCan(scope, "payments.workspace", centerId);
  const withPhones = scopeCan(scope, "students.phones", centerId);
  const rows = await workspaceSessionRoster(prisma, centerId, session, readOnly, { withPhones });
  const canEnd = writable && canCheckIn && !readOnly && displayStatus === "LIVE";
  const priceLabel = formatMoney(session.priceSnapshot, locale);
  const extraFields = { teacherId };
  // W9 (D-W42 item 9): homework from this session, with `assessments.manage` here, as the teacher's own (D-W03).
  const canAddHomework =
    writable && scopeCan(scope, "assessments.manage", centerId) && session.classGroupId !== null && displayStatus !== "CANCELLED" && displayStatus !== "RESCHEDULED";
  const tAssessments = await getTranslations("TeacherAssessments");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={sessionDisplayName(locale, session)}
        description={workspace.centerName}
        back={{ href: ROUTES.assistantWorkspaceSessions(teacherId, centerId), label: tAssistant("sessionsTitle") }}
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <SessionKindBadge kind={sessionKind(session)} />
            <Badge variant={STATUS_BADGE[displayStatus]}>{tStatus(displayStatus)}</Badge>
            <Badge variant="neutral">{tAssistant("private")}</Badge>
          </div>
        }
        action={
          canEnd ? (
            <WorkspaceEndSessionButton workspaceId={centerId} sessionId={session.id} closeAction={ASSISTANT_ACTIONS.close} extraFields={extraFields} />
          ) : undefined
        }
      />
      {writable ? null : <FormMessage tone="info">{tAssistant("archivedNote")}</FormMessage>}
      {!canCheckIn && !canPay ? <FormMessage tone="info">{tAssistant("readOnlyNote")}</FormMessage> : null}
      {canAddHomework ? (
        <LinkButton
          href={`${assessmentRoutes({ kind: "assistant", teacherId }).newBase}?type=HOMEWORK&session=${encodeURIComponent(session.id)}`}
          className="w-full sm:w-fit"
        >
          {tAssessments("addHomework")}
        </LinkButton>
      ) : null}
      <DetailLayout
        main={
          <DetailCard title={t("rosterTitle")} description={session.classGroupId ? t("rosterDescription") : t("oneTimeNote")}>
            <WorkspaceSessionRoster
              workspaceId={centerId}
              sessionId={session.id}
              rows={rows}
              priceLabel={priceLabel}
              writable={writable}
              readOnly={readOnly}
              actions={ASSISTANT_ACTIONS}
              extraFields={extraFields}
              canCheckIn={canCheckIn}
              canPay={canPay}
            />
          </DetailCard>
        }
        side={
          <DetailCard title={t("detailsTitle")} contentClassName="gap-0">
            <DetailRow stacked label={tSessions("fields.date")} value={formatDate(session.date, locale)} />
            <DetailRow stacked label={tSessions("fields.time")} value={formatTimeRange(session.startTime, session.endTime, locale)} />
            <DetailRow stacked label={tSessions("fields.status")} value={tStatus(displayStatus)} />
            <DetailRow stacked label={tSessions("fields.price")} value={priceLabel} />
          </DetailCard>
        }
      />
    </div>
  );
}
