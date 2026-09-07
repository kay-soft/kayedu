"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/i18n/navigation";
import { formatMoney, formatNumber } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import type { SessionDisplayStatus } from "@/lib/db/sessions";

export type SessionRowData = {
  sessionId: string;
  className: string;
  teacherName: string;
  roomName: string | null;
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
      <div className="flex w-24 shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.time")}</span>
        <span className="truncate text-sm tabular-nums text-text-secondary" dir="ltr">
          {session.startTime}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.class")}</span>
        <Link
          href={ROUTES.centerSession(session.sessionId)}
          className="truncate text-sm font-medium text-brand hover:underline"
        >
          {session.className}
        </Link>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.teacher")}</span>
        <span className="truncate text-sm text-text-secondary">{session.teacherName}</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.room")}</span>
        <span className="truncate text-sm text-text-secondary">{session.roomName ?? "—"}</span>
      </div>

      <div className="flex w-28 shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.marked")}</span>
        <span className="truncate text-sm tabular-nums text-text-secondary">
          {formatNumber(session.attendeeCount, locale)}
          {session.enrolledCount > 0 ? ` / ${formatNumber(session.enrolledCount, locale)}` : ""}
        </span>
      </div>

      <div className="flex w-28 shrink-0 flex-col">
        <span className="text-xs text-text-muted md:hidden">{t("columns.price")}</span>
        <span className="truncate text-sm tabular-nums text-text-secondary">
          {formatMoney(session.price, locale)}
        </span>
      </div>

      <div className="w-28 shrink-0">
        <Badge variant={STATUS_BADGE[session.displayStatus]}>
          {session.displayStatus === "LIVE" ? (
            <span className="me-1 inline-block size-1.5 animate-pulse rounded-full bg-success" aria-hidden />
          ) : null}
          {tStatus(session.displayStatus)}
        </Badge>
      </div>

      <div className="shrink-0 md:w-24 md:text-end">
        <Link
          href={ROUTES.centerSession(session.sessionId)}
          className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-text-primary hover:bg-surface-subtle md:h-9"
        >
          {t("open")}
        </Link>
      </div>
    </li>
  );
}
