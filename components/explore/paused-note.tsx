import { PauseCircle } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { formatDay } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * "Paused until <date>" (U5) — a branch a platform admin has paused, on the
 * public Explore pages and the signed-in Discover. Informational only:
 * enrolment in its classes stays possible while it is paused.
 */
export async function PausedNote({ until, className }: { until: Date; className?: string }) {
  const t = await getTranslations("BranchPause");
  const locale = await getLocale();
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium text-warning-fg", className)}>
      <PauseCircle className="size-3.5 shrink-0" aria-hidden />
      {t("pausedUntil", { date: formatDay(until, locale) })}
    </span>
  );
}
