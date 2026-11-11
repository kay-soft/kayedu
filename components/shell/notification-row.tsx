import type { NotificationKind } from "@prisma/client";
import { CalendarClock, CalendarX2, CircleCheck, CircleX, Clock, FileQuestion, UserPlus, type LucideIcon } from "lucide-react";

import { openNotificationAction } from "@/app/[locale]/notifications/actions";
import type { PresentedNotification } from "@/lib/notifications/present";
import { cn } from "@/lib/utils";

/**
 * Each kind's icon tile (docs/04 §11.31). The tone follows the fixed semantic
 * colours — approved green, declined/cancelled red, moved blue (upcoming), an
 * assessment coming up blue, one needing action soon amber (pending), as is a
 * workspace invitation waiting for an answer (W8b) — and is
 * never the only signal: the sentence says what happened.
 */
const KIND_ICON: Record<NotificationKind, { icon: LucideIcon; tone: string }> = {
  ENROLLMENT_APPROVED: { icon: CircleCheck, tone: "bg-success-bg text-success-fg" },
  BOOKING_APPROVED: { icon: CircleCheck, tone: "bg-success-bg text-success-fg" },
  ENROLLMENT_DECLINED: { icon: CircleX, tone: "bg-danger-bg text-danger-fg" },
  BOOKING_DECLINED: { icon: CircleX, tone: "bg-danger-bg text-danger-fg" },
  SESSION_CANCELLED: { icon: CalendarX2, tone: "bg-danger-bg text-danger-fg" },
  SESSION_RESCHEDULED: { icon: CalendarClock, tone: "bg-info-bg text-info-fg" },
  ASSESSMENT_PUBLISHED: { icon: FileQuestion, tone: "bg-info-bg text-info-fg" },
  ASSESSMENT_EXTENDED: { icon: CalendarClock, tone: "bg-info-bg text-info-fg" },
  ASSESSMENT_OPENS_SOON: { icon: Clock, tone: "bg-warning-bg text-warning-fg" },
  ASSESSMENT_DUE_SOON: { icon: Clock, tone: "bg-warning-bg text-warning-fg" },
  // W8b: an invitation waits for the student's answer — pending, amber.
  WORKSPACE_INVITATION: { icon: UserPlus, tone: "bg-warning-bg text-warning-fg" },
};

/**
 * One notice — in the bell's panel and on the inbox page alike (W1). The whole
 * row is one 44px+ button: it posts to `openNotificationAction`, which marks
 * the notice read and follows the kind's own deep link (works without
 * JavaScript). Unread reads bold **and** carries a brand dot plus a
 * screen-reader "Unread" — never colour alone.
 */
export function NotificationRow({
  item,
  locale,
  unreadLabel,
}: {
  item: PresentedNotification;
  locale: string;
  unreadLabel: string;
}) {
  const { icon: Icon, tone } = KIND_ICON[item.kind];
  return (
    <form action={openNotificationAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={item.id} />
      <button
        type="submit"
        data-notification-row
        className={cn(
          "flex min-h-11 w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-start text-sm",
          "transition-ui-fast focus-ring hover:bg-surface-hover active:bg-surface-active",
        )}
      >
        <span aria-hidden className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", tone)}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block break-words text-pretty",
              item.unread ? "font-semibold text-text-primary" : "text-text-secondary",
            )}
          >
            {item.unread ? <span className="sr-only">{`${unreadLabel}: `}</span> : null}
            {item.text}
          </span>
          <time dateTime={item.createdAt} className="mt-0.5 block text-xs text-text-muted">
            {item.time}
          </time>
        </span>
        {item.unread ? <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" /> : null}
      </button>
    </form>
  );
}
