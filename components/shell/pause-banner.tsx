import { PauseCircle } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { formatDay } from "@/lib/format";

/**
 * The centre shell's read-only notice while a platform admin's pause covers
 * the branch's today (U5): "Paused until <date> — contact KayEdu to change
 * this". No action — only KayEdu changes a pause. Sign-in and every read work
 * as usual; the writes a pause refuses say so themselves (`branchPaused`).
 */
export async function PauseBanner({ until }: { until: Date }) {
  const t = await getTranslations("BranchPause");
  const locale = await getLocale();
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-bg px-3 py-2.5 text-sm text-warning-fg"
    >
      <PauseCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0">{t("banner", { date: formatDay(until, locale) })}</p>
    </div>
  );
}
