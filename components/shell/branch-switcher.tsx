"use client";

import { Check, ChevronDown, Layers } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { selectCenterAction } from "@/app/[locale]/(auth)/actions";
import { BrandAvatar } from "@/components/shared/brand-avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type BranchOption = {
  id: string;
  name: string;
  logoUrl: string | null;
  themeColor: string;
};

export type RollupOption = {
  organizationId: string;
  organizationName: string;
  branchCount: number;
};

/**
 * The branch switcher (docs/04-design-system.md §11.1). It lives in the header
 * rather than the sidebar because it changes the scope of everything below it
 * and must stay visible when the sidebar collapses to a rail or a drawer.
 *
 * Replaces the plain "Switch branch" text link the header shipped with: that
 * showed no branch context at all — the one thing a switcher exists to show —
 * and read as a footnote next to the nav. Here the trigger *is* the context
 * (mark + branch name), and the panel is the list.
 *
 * **Hidden entirely for a single-branch user**, per §11.1: no disabled
 * control, no one-item dropdown. Each row submits the same
 * `selectCenterAction` the `/select-center` hub uses, so the switch itself is
 * unchanged — only where the user can reach it from.
 *
 * "Whole Management" is pinned above a divider with its own icon, because it
 * is a scope rather than a place and must not read as one more branch name.
 */
export function BranchSwitcher({
  activeName,
  activeLogoUrl,
  activeThemeColor,
  activeId,
  branches,
  rollups,
}: {
  activeName: string;
  activeLogoUrl: string | null;
  activeThemeColor: string;
  /** The centre — or organization, under a roll-up — currently in scope. */
  activeId: string | null;
  branches: BranchOption[];
  rollups: RollupOption[];
}) {
  const t = useTranslations("Shell");
  const locale = useLocale();

  if (branches.length <= 1 && rollups.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "group flex h-11 max-w-[13rem] min-w-0 items-center gap-2 rounded-lg border border-transparent px-2",
          "text-sm font-medium text-text-primary transition-ui outline-none",
          "hover:border-border hover:bg-surface-hover active:bg-surface-active",
          "focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/25",
          "data-[popup-open]:border-border data-[popup-open]:bg-surface-hover",
        )}
      >
        <BrandAvatar
          name={activeName}
          logoUrl={activeLogoUrl}
          themeColor={activeThemeColor}
          size="sm"
        />
        <span className="hidden min-w-0 flex-col text-start sm:flex">
          <span className="truncate text-[11px] leading-tight font-medium text-text-muted">
            {t("branchLabel")}
          </span>
          <span className="truncate text-sm leading-tight">{activeName}</span>
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-text-muted transition-transform duration-[var(--motion-fast)] group-data-[popup-open]:rotate-180"
          aria-hidden
        />
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64">
        {rollups.length > 0 ? (
          <div className="border-b border-border pb-1">
            {rollups.map((group) => (
              <form key={group.organizationId} action={selectCenterAction}>
                <input type="hidden" name="locale" value={locale} />
                <input
                  type="hidden"
                  name="selectionId"
                  value={group.organizationId}
                />
                <button
                  type="submit"
                  aria-current={
                    activeId === group.organizationId ? true : undefined
                  }
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-start",
                    "text-text-primary transition-ui-fast focus-ring",
                    "hover:bg-surface-hover active:bg-surface-active",
                    "aria-[current=true]:bg-brand/10 aria-[current=true]:text-brand",
                  )}
                >
                  <span
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"
                  >
                    <Layers className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {t("wholeManagement", {
                        organization: group.organizationName,
                      })}
                    </span>
                    <span className="block truncate text-xs text-text-muted">
                      {t("wholeManagementHint", { count: group.branchCount })}
                    </span>
                  </span>
                  {activeId === group.organizationId ? (
                    <Check className="size-4 shrink-0" aria-hidden />
                  ) : null}
                </button>
              </form>
            ))}
          </div>
        ) : null}

        <p className="px-2 pt-2 pb-1 text-[11px] font-medium text-text-muted">
          {t("branchesLabel")}
        </p>

        {branches.map((branch) => (
          <form key={branch.id} action={selectCenterAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="selectionId" value={branch.id} />
            <button
              type="submit"
              aria-current={activeId === branch.id ? true : undefined}
              className={cn(
                "flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-start",
                "text-text-primary transition-ui-fast focus-ring",
                "hover:bg-surface-hover active:bg-surface-active",
                "aria-[current=true]:bg-brand/10 aria-[current=true]:font-medium aria-[current=true]:text-brand",
              )}
            >
              <BrandAvatar
                name={branch.name}
                logoUrl={branch.logoUrl}
                themeColor={branch.themeColor}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {branch.name}
              </span>
              {/* The slot is reserved whether or not this is the active
                  branch, so names line up down the list. */}
              <span className="flex size-4 shrink-0 items-center justify-center">
                {activeId === branch.id ? (
                  <Check className="size-4" aria-hidden />
                ) : null}
              </span>
            </button>
          </form>
        ))}
      </PopoverContent>
    </Popover>
  );
}
