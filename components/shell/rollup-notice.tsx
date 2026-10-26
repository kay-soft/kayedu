"use client";

import { Info } from "lucide-react";
import { useTranslations } from "next-intl";

import { usePathname } from "@/lib/i18n/navigation";

/**
 * Under "Whole Management" only Analytics sums the organization; every other
 * centre page still renders the one representative branch the queries scope on
 * (docs/02-architecture.md §4). The header deliberately no longer names that
 * branch, so this one line, above the page, does: it says whose data is on
 * screen and how to change it. Presentation only — no page's data changes.
 */
export function RollupNotice({
  branchName,
  analyticsHref,
}: {
  branchName: string;
  analyticsHref: string;
}) {
  const t = useTranslations("Shell");
  const pathname = usePathname();

  if (pathname === analyticsHref || pathname.startsWith(`${analyticsHref}/`)) {
    return null;
  }

  return (
    <p
      role="note"
      className="mb-4 flex items-start gap-2 rounded-lg border border-info/30 bg-info-bg px-3 py-2 text-sm text-info-fg"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{t("rollupShowingBranch", { branch: branchName })}</span>
    </p>
  );
}
