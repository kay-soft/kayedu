"use client";

import { useState, useTransition } from "react";
import { Bell } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  loadNotificationPanelAction,
  type NotificationPanelData,
} from "@/app/[locale]/notifications/actions";
import { NotificationRow } from "@/components/shell/notification-row";
import { Popover, PopoverContent, PopoverTrigger, popoverItemClass } from "@/components/ui/popover";
import { formatNumber } from "@/lib/format";
import { Link } from "@/lib/i18n/navigation";
import { notificationsPath, type AccountOrigin } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** From this many unread notices the badge reads "9+" (the Approvals badge recipe, F7). */
const BADGE_CAP = 9;

/**
 * The bell in every shell's app bar (W1, D-W12; docs/04 §11.31), at the inline
 * end before the user menu. `unread` is server-rendered by the shell on every
 * navigation — never polled. Opening the panel loads the latest notices once
 * (`loadNotificationPanelAction`), then a link opens the full inbox inside the
 * same shell (`?from=`).
 *
 * The badge is decoration: the button's accessible name carries the full,
 * uncapped count ("Notifications, 12 unread"). Below `sm` the panel spans the
 * screen less the 16px gutters.
 */
export function NotificationBell({ unread, from }: { unread: number; from: AccountOrigin }) {
  const t = useTranslations("Notifications");
  const locale = useLocale();
  const [data, setData] = useState<NotificationPanelData | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, startLoading] = useTransition();

  function load() {
    startLoading(async () => {
      try {
        const result = await loadNotificationPanelAction(locale);
        setData(result);
        setFailed(result === null);
      } catch {
        setFailed(true);
      }
    });
  }

  const name = unread > 0 ? t("bellUnread", { count: formatNumber(unread, locale) }) : t("bell");
  const badge = unread > BADGE_CAP ? t("capped", { max: formatNumber(BADGE_CAP, locale) }) : formatNumber(unread, locale);

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <PopoverTrigger
        aria-label={name}
        title={name}
        data-notification-bell
        className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-ui focus-ring hover:bg-surface-hover hover:text-text-primary active:bg-surface-active data-[popup-open]:bg-surface-hover data-[popup-open]:text-text-primary"
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 ? (
          <span
            aria-hidden
            data-notification-badge
            dir="ltr"
            className="absolute top-1 end-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning-bg px-1 text-xs leading-none font-semibold text-warning-fg tabular-nums"
          >
            {badge}
          </span>
        ) : null}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        aria-label={t("title")}
        className="w-[min(24rem,calc(100vw-2rem))] max-w-[min(24rem,calc(100vw-2rem))] p-0"
      >
        <p className="border-b border-border px-3 py-2.5 text-sm font-semibold text-text-primary">{t("title")}</p>

        <div className="p-1" aria-busy={loading || undefined}>
          {data && data.items.length > 0 ? (
            <ul className={cn("flex flex-col", loading && "opacity-60")}>
              {data.items.map((item) => (
                <li key={item.id}>
                  <NotificationRow item={item} locale={locale} unreadLabel={t("unread")} />
                </li>
              ))}
            </ul>
          ) : data ? (
            <div className="flex flex-col items-center gap-1 px-3 py-6 text-center">
              <p className="text-sm font-medium text-text-primary">{t("empty.title")}</p>
              <p className="text-xs text-text-muted">{t("empty.description")}</p>
            </div>
          ) : failed && !loading ? (
            <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
              <p role="alert" className="text-sm text-text-secondary">
                {t("loadFailed")}
              </p>
              <button type="button" onClick={load} className={cn(popoverItemClass, "w-auto justify-center font-medium text-brand")}>
                {t("retry")}
              </button>
            </div>
          ) : (
            <p role="status" className="px-3 py-6 text-center text-sm text-text-muted">
              {t("loading")}
            </p>
          )}
        </div>

        <div className="border-t border-border p-1">
          <Link href={notificationsPath(from)} className={cn(popoverItemClass, "justify-center font-medium text-brand")}>
            {t("seeAll")}
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
