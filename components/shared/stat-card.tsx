import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** KPI / stat card — docs/04 §5. Label above, large figure below. */
export function StatCard({
  label,
  value,
  hint,
  icon,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-surface p-4 shadow-card sm:p-6",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium text-text-muted">{label}</span>
        {icon ? <span className="text-text-muted">{icon}</span> : null}
      </div>
      <p className="mt-2 text-3xl font-bold tabular-nums text-text-primary">
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}
