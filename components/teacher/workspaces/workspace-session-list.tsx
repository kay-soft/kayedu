import { CalendarSearch } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import {
  CancelWorkspaceSessionButton,
  DeleteWorkspaceSessionButton,
  RescheduleWorkspaceSessionButton,
} from "@/components/teacher/workspaces/workspace-session-controls";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { SessionKindBadge } from "@/components/shared/session-kind-badge";
import { Badge } from "@/components/ui/badge";
import { deriveSessionDisplayStatus } from "@/lib/db/sessions";
import type { WorkspaceSessionRow } from "@/lib/db/workspaces";
import { formatDate, formatDay, formatMoney, formatTime, formatTimeRange } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { dateKey } from "@/lib/scheduling";
import { sessionDisplayName, sessionKind } from "@/lib/session-label";

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

/**
 * A workspace's sessions as stacked cards (W8a, docs/04 §11.37) — the same
 * card the teacher's Sessions list draws, with the verbs the engine allows on
 * a session that has not started: Reschedule and Cancel, and Delete for an
 * extra or one-time one. Write controls only while the workspace takes writes.
 * W8c: every row opens its session page (roster, payments, receipt), read-only
 * included.
 */
export async function WorkspaceSessionList({
  workspaceId,
  rows,
  timeZone,
  todayIso,
  writable,
}: {
  workspaceId: string;
  rows: WorkspaceSessionRow[];
  timeZone: string;
  todayIso: string;
  writable: boolean;
}) {
  const [t, tStatus, tSessions, locale] = await Promise.all([
    getTranslations("Workspaces.sessions"),
    getTranslations("Sessions.status"),
    getTranslations("Sessions"),
    getLocale(),
  ]);
  const now = new Date();
  if (rows.length === 0) {
    return <EmptyState icon={<CalendarSearch />} title={t("empty")} description={t("emptyHint")} />;
  }
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => {
        const status = deriveSessionDisplayStatus(row, now, timeZone);
        const kind = sessionKind(row);
        const actionable = writable && status === "SCHEDULED";
        return (
          <li key={row.id} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
                  <span className="min-w-0 break-words">{sessionDisplayName(locale, row)}</span>
                  <SessionKindBadge kind={kind} />
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                  <span>{formatDate(row.date, locale)}</span>
                  <span>{formatTimeRange(row.startTime, row.endTime, locale)}</span>
                  <span>{formatMoney(row.priceSnapshot, locale)}</span>
                </p>
                {row.rescheduledFrom ? (
                  <p className="mt-1 text-xs text-text-secondary">
                    {tSessions("movedFrom", {
                      date: formatDay(row.rescheduledFrom.date, locale),
                      time: formatTime(row.rescheduledFrom.startTime, locale),
                    })}
                  </p>
                ) : null}
              </div>
              <Badge variant={STATUS_BADGE[status]} className="w-fit shrink-0">
                {tStatus(status)}
              </Badge>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <LinkButton href={ROUTES.teacherWorkspaceSession(workspaceId, row.id)} className="w-full sm:w-fit">
                {t("open")}
              </LinkButton>
              {actionable ? (
              <>
                <RescheduleWorkspaceSessionButton
                  workspaceId={workspaceId}
                  sessionId={row.id}
                  todayIso={todayIso}
                  defaults={{ date: dateKey(row.date), startTime: row.startTime, endTime: row.endTime }}
                />
                <CancelWorkspaceSessionButton workspaceId={workspaceId} sessionId={row.id} />
                {kind !== "class" ? <DeleteWorkspaceSessionButton workspaceId={workspaceId} sessionId={row.id} /> : null}
              </>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
