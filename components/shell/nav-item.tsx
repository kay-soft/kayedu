"use client";

import { Link } from "@/lib/i18n/navigation";
import { ShellIcon } from "@/components/shell/shell-icon";
import type { ShellNavItem } from "@/components/shell/nav";
import { cn } from "@/lib/utils";

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
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
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
      <ShellIcon name={item.icon} className="size-4 shrink-0" />
      <span className={cn("truncate", collapsed && "sr-only")}>{label}</span>
    </Link>
  );
}
