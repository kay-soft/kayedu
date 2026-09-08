import { Skeleton } from "@/components/shared/skeleton";

/**
 * Auth loading state (docs/04-design-system.md §5 "Loading state"). These
 * screens are one card, so the skeleton is one card — a page-shaped skeleton
 * here would promise a layout that never arrives.
 */
export default function AuthLoading() {
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-card p-6 ring-1 ring-foreground/10">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-56" />
      <Skeleton className="mt-2 h-11 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="mt-2 h-11 w-full" />
    </div>
  );
}
