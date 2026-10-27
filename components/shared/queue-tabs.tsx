"use client";

import { useLocale } from "next-intl";

import { Select } from "@/components/ui/select";
import { SoftLink } from "@/components/shared/soft-link";
import { useUrlFilters } from "@/components/shared/url-filters";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export type QueueTab = {
  /** The `?type=` value. The tab whose key is `allKey` is the bare URL. */
  key: string;
  label: string;
  /** Pending requests behind the tab — a tab with none stays, muted. */
  count: number;
};

/**
 * The type tabs of an approvals queue (F7, docs/04 §11.3): one pill per kind of
 * request with how many are waiting, the selected kind in the URL (`?type=`).
 *
 * From `sm` the pills are `SoftLink`s — real hrefs, shareable, still prefetched,
 * moved softly (T4, docs/02 §14). Below `sm` the same choice is a `Select`
 * that moves the URL through `useUrlFilters` — a strip of seven pills would
 * scroll sideways on a phone, and primary navigation never scrolls sideways
 * (docs/04 §6). Both read one `tabs` array, so they cannot disagree.
 */
export function QueueTabs({
  tabs,
  active,
  basePath,
  label,
  selectLabel,
  allKey = "all",
  param = "type",
}: {
  tabs: QueueTab[];
  active: string;
  basePath: string;
  label: string;
  selectLabel: string;
  allKey?: string;
  param?: string;
}) {
  const locale = useLocale();
  const filters = useUrlFilters();
  const hrefFor = (key: string) => (key === allKey ? basePath : `${basePath}?${param}=${key}`);

  return (
    <>
      <nav aria-label={label} className="hidden flex-wrap gap-2 sm:flex">
        {tabs.map((tab) => {
          const selected = tab.key === active;
          return (
            <SoftLink
              key={tab.key}
              href={hrefFor(tab.key)}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-ui-fast",
                selected
                  ? "border-brand bg-brand text-brand-foreground"
                  : tab.count === 0
                    ? "border-border bg-surface text-text-muted hover:border-brand hover:text-text-primary"
                    : "border-border bg-surface text-text-secondary hover:border-brand hover:text-text-primary",
              )}
            >
              {tab.label}
              <span className="tabular-nums">{formatNumber(tab.count, locale)}</span>
            </SoftLink>
          );
        })}
      </nav>

      <div className="sm:hidden">
        <Select
          aria-label={selectLabel}
          value={active}
          onValueChange={(next) => filters.update([[param, next === allKey ? "" : next]])}
          options={tabs.map((tab) => ({
            value: tab.key,
            label: `${tab.label} (${formatNumber(tab.count, locale)})`,
          }))}
        />
      </div>
    </>
  );
}
