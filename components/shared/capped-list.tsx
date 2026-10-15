import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * A long list shown a screenful at a time (DES, docs/04 §14.9): the first
 * `limit` rows, then a disclosure for the rest. Display only — every row is
 * already loaded; nothing about the query changes. A parent's whole term of
 * upcoming sessions had been one 6,000px column on a phone.
 */
export function CappedList<T>({
  items,
  limit = 8,
  render,
  moreLabel,
}: {
  items: T[];
  limit?: number;
  render: (item: T) => ReactNode;
  /** Already translated, for the number of hidden rows. */
  moreLabel: (hidden: number) => string;
}) {
  const head = items.slice(0, limit);
  const rest = items.slice(limit);

  return (
    <>
      {head.map(render)}
      {rest.length > 0 ? (
        <details className="group flex flex-col">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-center gap-2 rounded-lg border border-border-control bg-surface px-4 text-sm font-medium text-text-secondary transition-ui focus-ring hover:bg-surface-hover hover:text-text-primary group-open:hidden [&::-webkit-details-marker]:hidden">
            <ChevronDown className="size-4" aria-hidden />
            {moreLabel(rest.length)}
          </summary>
          <div className="flex flex-col gap-3">{rest.map(render)}</div>
        </details>
      ) : null}
    </>
  );
}
