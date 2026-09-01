"use client";

import { Link } from "@/lib/i18n/navigation";
import { ShellIcon } from "@/components/shell/shell-icon";
import type { ShellNavItem } from "@/components/shell/nav";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * One sidebar nav item — docs/04 §5: icon + label, the active item highlighted
 * with the brand color and marked by a logical start-edge indicator (so it
 * mirrors correctly in RTL, docs/04 §7). Minimum 44px tall for touch.
 *
 * Items the current milestone has not built yet render as a disabled row with
 * a "Soon" badge rather than a dead link.
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
  soonLabel,
  collapsed,
  onNavigate,
}: {
  item: ShellNavItem;
  active: boolean;
  label: string;
  soonLabel: string;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  if (item.disabled) {
    return (
      <span
        aria-disabled="true"
        title={collapsed ? label : undefined}
        className={cn(
          "flex min-h-11 cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-muted/70",
          collapsed && "justify-center px-0",
        )}
      >
        <ShellIcon name={item.icon} className="size-4 shrink-0" />
        <span className={cn("flex-1 truncate", collapsed && "sr-only")}>
          {label}
        </span>
        {collapsed ? null : (
          <Badge
            variant="neutral"
            className="bg-white/5 text-text-muted ring-white/10"
          >
            {soonLabel}
          </Badge>
        )}
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
        collapsed && "justify-center px-0",
        active
          ? "bg-brand font-medium text-brand-foreground before:absolute before:inset-y-1 before:start-0 before:w-1 before:rounded-e-full before:bg-brand-foreground/70 before:content-['']"
          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      )}
    >
      <ShellIcon name={item.icon} className="size-4 shrink-0" />
      <span className={cn("truncate", collapsed && "sr-only")}>{label}</span>
    </Link>
  );
}
