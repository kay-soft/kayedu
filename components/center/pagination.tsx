import { ChevronLeft, ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Link } from "@/lib/i18n/navigation";

/**
 * Prev/next paging for a list page (docs/02-architecture.md §14). A center
 * with thousands of students must never load them all at once — this is the
 * control that keeps the query bounded, driven entirely by the URL so a page
 * is a real, shareable, back-button-safe address rather than client state.
 */
export async function Pagination({
  page,
  pageSize,
  total,
  buildHref,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** Builds the href for a given page number, keeping the current filters. */
  buildHref: (page: number) => string;
}) {
  const t = await getTranslations("Shared.pagination");
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label={t("label")}
      className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm text-text-muted">
        {t("range", { from, to, total })}
      </p>

      <div className="flex items-center justify-center gap-2">
        {page > 1 ? (
          <Link
            href={buildHref(page - 1)}
            className="flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-surface-subtle"
          >
            {/* The arrow means "previous", so it mirrors in RTL (docs/04 §7). */}
            <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden />
            {t("previous")}
          </Link>
        ) : (
          <span
            aria-disabled
            className="flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg border border-border px-3 text-sm text-text-muted/60"
          >
            <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden />
            {t("previous")}
          </span>
        )}

        <span className="px-2 text-sm tabular-nums text-text-secondary">
          {t("pageOf", { page, totalPages })}
        </span>

        {page < totalPages ? (
          <Link
            href={buildHref(page + 1)}
            className="flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-surface-subtle"
          >
            {t("next")}
            <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
          </Link>
        ) : (
          <span
            aria-disabled
            className="flex h-11 min-w-11 items-center justify-center gap-1 rounded-lg border border-border px-3 text-sm text-text-muted/60"
          >
            {t("next")}
            <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
          </span>
        )}
      </div>
    </nav>
  );
}
