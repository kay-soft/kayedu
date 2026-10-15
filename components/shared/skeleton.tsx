import { cn } from "@/lib/utils";

/**
 * Loading placeholders (docs/04-design-system.md §5 "Loading state"). A
 * skeleton exists to say "this region is arriving and it will be *this*
 * shape" — so these compose into the layout the real screen uses (a KPI row
 * is four cards, a list is a header plus rows), never a single grey bar
 * standing in for a whole page.
 *
 * The pulse is a plain CSS animation, and the global reduced-motion rule in
 * `globals.css` stops it for anyone who has asked for that.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-lg bg-surface-active", className)}
    />
  );
}

/** A page header's title + description block. */
export function SkeletonPageHeader() {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-11 w-32" />
    </div>
  );
}

/** A KPI row — same grid as `StatCard`'s callers, so nothing shifts on load. */
export function SkeletonStatRow({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="rounded-xl border border-border bg-surface p-4 shadow-card sm:p-6"
        >
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-8 w-32" />
        </div>
      ))}
    </div>
  );
}

/** A card wrapping a list — the shape every list-first screen in the ERP uses. */
export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-card md:p-5">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, index) => (
          <div
            key={index}
            className="flex items-center gap-4 rounded-xl border border-border p-3 md:rounded-none md:border-0 md:border-b md:px-2"
          >
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <Skeleton className="h-4 min-w-0 flex-1" />
            <Skeleton className="hidden h-4 w-32 md:block" />
            <Skeleton className="h-6 w-16 shrink-0 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The default page-level loading shape: header, KPI row, list. */
export function SkeletonPage({
  stats = 4,
  rows = 5,
}: {
  stats?: number;
  rows?: number;
}) {
  return (
    <div className="flex flex-col gap-6">
      <SkeletonPageHeader />
      {stats > 0 ? <SkeletonStatRow count={stats} /> : null}
      <SkeletonList rows={rows} />
    </div>
  );
}
