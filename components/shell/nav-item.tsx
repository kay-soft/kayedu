"use client";

import { useLocale, useTranslations } from "next-intl";

import { Link } from "@/lib/i18n/navigation";
import { ShellIcon } from "@/components/shell/shell-icon";
import type { ShellNavItem } from "@/components/shell/nav";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/** From this many pending requests the badge reads "9+" rather than the number. */
const BADGE_CAP = 9;

/**
 * One sidebar nav item — docs/04 §5: icon + label, the active item highlighted
 * with the brand color and marked by a logical start-edge indicator (so it
 * mirrors correctly in RTL, docs/04 §7). Minimum 44px tall for touch.
 *
 * Every item is a real link: a route a later milestone owns is simply absent
 * from the nav (R10a removed the "Soon" placeholder rows).
 *
 * `collapsed` renders the icon-only rail (docs/04 §5 "Sidebar"): the label is
 * visually hidden rather than unmounted (still in the accessibility tree),
 * and the native `title` attribute gives a hover tooltip without a separate
 * tooltip library for a single-line label.
 *
 * `item.pendingCount` (F7) draws the amber count badge — at the end of the
 * row, or on the icon's corner on the rail. The badge is decoration: the
 * link's accessible name carries the full, uncapped count ("Approvals, 12
 * pending").
 */
export function NavItem({
  item,
  active,
  label,
  collapsed,
  onNavigate,
}: {
  item: ShellNavItem;
  active: boolean;
  label: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const tShell = useTranslations("Shell");
  const locale = useLocale();
  const pending = item.pendingCount && item.pendingCount > 0 ? item.pendingCount : 0;
  const accessibleName = pending
    ? tShell("pendingNavLabel", { label, count: formatNumber(pending, locale) })
    : undefined;
  const badgeText =
    pending > BADGE_CAP
      ? tShell("pendingCapped", { max: formatNumber(BADGE_CAP, locale) })
      : formatNumber(pending, locale);

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-label={accessibleName}
      title={collapsed ? (accessibleName ?? label) : undefined}
      className={cn(
        // The one focus ring, in its on-dark form (docs/04 §4). The active item
        // is the solid brand pill alone — the white start-edge tab drawn on it
        // read as a rendering glitch (DES, §14.3).
        "relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-ui focus-ring-inverse",
        collapsed && "justify-center px-0",
        active
          ? "bg-brand font-medium text-brand-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <span className="relative flex shrink-0">
        <ShellIcon name={item.icon} className="size-4 shrink-0" />
        {pending && collapsed ? (
          <span
            aria-hidden
            dir="ltr"
            className="absolute -top-2 -end-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning-bg px-1 text-xs leading-none font-semibold text-warning-fg tabular-nums"
          >
            {badgeText}
          </span>
        ) : null}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", collapsed && "sr-only")}>{label}</span>
      {pending && !collapsed ? (
        <span
          aria-hidden
          dir="ltr"
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-warning-bg px-1.5 text-xs leading-none font-semibold text-warning-fg tabular-nums"
        >
          {badgeText}
        </span>
      ) : null}
    </Link>
  );
}
