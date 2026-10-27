import { ShellIcon } from "@/components/shell/shell-icon";
import type { ShellNavItem } from "@/components/shell/nav";
import { cn } from "@/lib/utils";

/**
 * A branch-scoped nav item under "Whole Management" (docs/04 §11.1, T6):
 * every item except Analytics, which is the only page with a roll-up
 * meaning. It stays in the nav — not a link — with a one-line reason. An item
 * that vanished would read as a permission problem. This is not a "Soon"
 * placeholder: it exists only while a roll-up is the active scope, and
 * `NavItem` itself stays a real link. A direct URL still reaches the page,
 * which renders the pick-a-branch screen (`PickBranchScreen`).
 */
export function RollupNavItem({
  item,
  label,
  reason,
  collapsed,
}: {
  item: ShellNavItem;
  label: string;
  reason: string;
  collapsed?: boolean;
}) {
  return (
    <span
      aria-disabled="true"
      title={collapsed ? `${label} — ${reason}` : reason}
      className={cn(
        "flex min-h-11 cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-on-dark-muted",
        collapsed && "justify-center px-0",
      )}
    >
      <ShellIcon name={item.icon} className="size-4 shrink-0 opacity-60" />
      <span className={cn("min-w-0 flex-col", collapsed ? "sr-only" : "flex")}>
        <span className="truncate">{label}</span>
        <span className="truncate text-xs leading-tight">{reason}</span>
      </span>
    </span>
  );
}
