import { getTranslations } from "next-intl/server";
import { CalendarClock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { SessionDisplayStatus } from "@/lib/db/sessions";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { EmptyState } from "@/components/shared/empty-state";

export type LiveSessionOption = {
  sessionId: string;
  className: string;
  teacherName: string;
  startTime: string;
  endTime: string;
  displayStatus: SessionDisplayStatus;
};

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

/**
 * "Today's sessions marked live" (spec §4.1 item 8) — an informational rail
 * next to the check-in flow, so staff can see what's running right now
 * without leaving Reception. `AddSessionShortcut` sits beside it for a
 * session outside today (or not yet generated).
 */
export async function LiveSessionRail({ sessions }: { sessions: LiveSessionOption[] }) {
  const t = await getTranslations("Reception");
  const tStatus = await getTranslations("Sessions.status");

  if (sessions.length === 0) {
    return (
      <EmptyState
        compact
        icon={<CalendarClock />}
        title={t("noSessionsToday")}
        description={t("noSessionsTodayHint")}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {sessions.map((session) => (
        <li
          key={session.sessionId}
          className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
        >
          <div className="min-w-0">
            <Link
              href={ROUTES.centerSession(session.sessionId)}
              className="truncate text-sm font-medium text-brand hover:underline"
            >
              {session.className}
            </Link>
            <p className="truncate text-xs text-text-muted">{session.teacherName}</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="text-xs tabular-nums text-text-secondary" dir="ltr">
              {session.startTime}
            </span>
            <Badge variant={STATUS_BADGE[session.displayStatus]}>
              {session.displayStatus === "LIVE" ? (
                <span
                  className="me-1 inline-block size-1.5 animate-pulse rounded-full bg-success"
                  aria-hidden
                />
              ) : null}
              {tStatus(session.displayStatus)}
            </Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}
