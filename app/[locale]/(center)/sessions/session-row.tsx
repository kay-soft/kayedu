"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/i18n/navigation";
import { formatDate, formatMoney, formatNumber, formatTimeRange } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import type { SessionDisplayStatus } from "@/lib/db/sessions";
import { LinkButton } from "@/components/shared/link-button";
import { SessionKindBadge } from "@/components/shared/session-kind-badge";
import type { SessionKind } from "@/lib/session-label";

export type SessionRowData = {
  sessionId: string;
  className: string;
  /** R5 — "One-time" / "Extra session" badge beside the name. */
  kind: SessionKind;
  teacherName: string;
  roomName: string | null;
  date: Date;
  startTime: string;
  endTime: string;
  price: number;
  attendeeCount: number;
  enrolledCount: number;
  displayStatus: SessionDisplayStatus;
};

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  RESCHEDULED: "warning",
} as const;

/** One session. Stacked card below `md`, table row from `md` up (docs/04 §6). */
export function SessionRow({ session, locale }: { session: SessionRowData; locale: string }) {
  const t = useTranslations("Sessions");
  const tStatus = useTranslations("Sessions.status");

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border p-3 md:flex-row md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3">
      <div className="flex md:w-44 md:shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.when")}</span>
        <span className="truncate text-sm text-text-secondary">
          {formatDate(session.date, locale)}
        </span>
        <span className="truncate text-xs tabular-nums text-text-muted" suppressHydrationWarning>
          {formatTimeRange(session.startTime, session.endTime, locale)}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.class")}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={ROUTES.centerSession(session.sessionId)}
            className="min-w-0 truncate text-sm font-medium text-brand hover:underline"
          >
            {session.className}
          </Link>
          <SessionKindBadge kind={session.kind} />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.teacher")}</span>
        <span className="truncate text-sm text-text-secondary">{session.teacherName}</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.room")}</span>
        <span className="truncate text-sm text-text-secondary">{session.roomName ?? "—"}</span>
      </div>

      <div className="flex md:w-28 md:shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.marked")}</span>
        <span className="truncate text-sm tabular-nums text-text-secondary">
          {formatNumber(session.attendeeCount, locale)}
          {session.enrolledCount > 0 ? ` / ${formatNumber(session.enrolledCount, locale)}` : ""}
        </span>
      </div>

      <div className="flex md:w-28 md:shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.price")}</span>
        <span className="truncate text-sm tabular-nums text-text-secondary">
          {formatMoney(session.price, locale)}
        </span>
      </div>

      <div className="md:w-28 md:shrink-0">
        <Badge variant={STATUS_BADGE[session.displayStatus]}>
          {session.displayStatus === "LIVE" ? (
            <span className="me-1 inline-block size-1.5 animate-pulse rounded-full bg-success" aria-hidden />
          ) : null}
          {tStatus(session.displayStatus)}
        </Badge>
      </div>

      <div className="shrink-0 md:w-24 md:text-end">
        <LinkButton href={ROUTES.centerSession(session.sessionId)} className="md:h-9">
          {t("open")}
        </LinkButton>
      </div>
    </li>
  );
}
