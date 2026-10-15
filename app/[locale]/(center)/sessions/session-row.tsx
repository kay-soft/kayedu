"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/i18n/navigation";
import { formatDate, formatMoney, formatNumber, formatTimeRange } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import type { SessionDisplayStatus } from "@/lib/db/sessions";
import { SessionKindBadge } from "@/components/shared/session-kind-badge";
import type { SessionKind } from "@/lib/session-label";
import { cn } from "@/lib/utils";

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

/**
 * Column widths shared by the list header and every row (docs/04 §14.6). The
 * fixed columns are narrow enough that the name and teacher keep their room
 * at 768, where the old widths had squeezed them to nothing; the room joins
 * as its own column from `lg` and sits under the teacher before that.
 */
export const SESSION_COLUMNS = {
  when: "md:w-36 md:shrink-0 lg:w-44",
  name: "md:min-w-0 md:flex-[2]",
  teacher: "md:min-w-0 md:flex-1",
  room: "lg:min-w-0 lg:flex-1",
  marked: "md:w-20 md:shrink-0 md:text-end",
  price: "md:w-24 md:shrink-0 md:text-end",
  status: "md:w-28 md:shrink-0",
} as const;

/** The per-cell label: visible on a phone's card, read out (not shown) from `md`. */
const CELL_LABEL = "text-xs text-text-secondary md:sr-only";

/**
 * One session (docs/04 §14.6): a compact card below `md` — the name and its
 * status on the first line, when on the second, the rest as a two-column
 * list — and a table row from `md`. The name is the link; the separate "Open"
 * button it used to carry was a second tab stop to the same page.
 */
export function SessionRow({ session, locale }: { session: SessionRowData; locale: string }) {
  const t = useTranslations("Sessions");
  const tStatus = useTranslations("Sessions.status");
  const status = (
    <Badge variant={STATUS_BADGE[session.displayStatus]} pulse={session.displayStatus === "LIVE"}>
      {tStatus(session.displayStatus)}
    </Badge>
  );

  return (
    <li className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border p-3 md:flex md:items-center md:gap-4 md:rounded-none md:border-0 md:border-b md:px-2 md:py-3 md:transition-ui md:hover:bg-surface-hover">
      <div className={cn("col-span-2 flex min-w-0 items-start justify-between gap-2 md:order-2", SESSION_COLUMNS.name)}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={ROUTES.centerSession(session.sessionId)}
            className="min-w-0 rounded-sm text-sm font-medium break-words text-brand focus-ring hover:underline md:line-clamp-2"
          >
            {session.className}
          </Link>
          <SessionKindBadge kind={session.kind} />
        </div>
        <span className="shrink-0 md:hidden">{status}</span>
      </div>

      <div className={cn("col-span-2 flex flex-wrap gap-x-2 text-sm text-text-secondary md:order-1 md:flex-col md:gap-0", SESSION_COLUMNS.when)}>
        <span className={CELL_LABEL}>{t("columns.when")}</span>
        <span className="truncate">{formatDate(session.date, locale)}</span>
        <span className="truncate tabular-nums md:text-xs md:text-text-secondary" suppressHydrationWarning>
          {formatTimeRange(session.startTime, session.endTime, locale)}
        </span>
      </div>

      <div className={cn("flex min-w-0 flex-col md:order-3", SESSION_COLUMNS.teacher)}>
        <span className={CELL_LABEL}>{t("columns.teacher")}</span>
        <span className="text-sm break-words text-text-secondary md:line-clamp-2" dir="auto">
          {session.teacherName}
        </span>
        <span className="hidden truncate text-xs text-text-secondary md:block lg:hidden">
          {session.roomName ?? ""}
        </span>
      </div>

      <div className={cn("flex min-w-0 flex-col md:hidden lg:order-4 lg:flex", SESSION_COLUMNS.room)}>
        <span className={CELL_LABEL}>{t("columns.room")}</span>
        <span className="truncate text-sm text-text-secondary">{session.roomName ?? "—"}</span>
      </div>

      <div className={cn("flex flex-col md:order-5", SESSION_COLUMNS.marked)}>
        <span className={CELL_LABEL}>{t("columns.marked")}</span>
        <span className="text-sm whitespace-nowrap tabular-nums text-text-secondary">
          {formatNumber(session.attendeeCount, locale)}
          {session.enrolledCount > 0 ? ` / ${formatNumber(session.enrolledCount, locale)}` : ""}
        </span>
      </div>

      <div className={cn("flex flex-col md:order-6", SESSION_COLUMNS.price)}>
        <span className={CELL_LABEL}>{t("columns.price")}</span>
        <span className="text-sm whitespace-nowrap tabular-nums text-text-secondary">
          {formatMoney(session.price, locale)}
        </span>
      </div>

      <div className={cn("hidden md:order-7 md:block", SESSION_COLUMNS.status)}>{status}</div>
    </li>
  );
}
