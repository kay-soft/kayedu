import { SkeletonPage } from "@/components/shared/skeleton";

/**
 * Student portal loading state (docs/04-design-system.md §5 "Loading state").
 * Mirrors the real screen's shape — header, KPI row, list — so the layout
 * does not jump when the data lands, and a slow query never shows a blank
 * panel.
 */
export default function StudentLoading() {
  return <SkeletonPage stats={0} />;
}
