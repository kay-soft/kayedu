import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";

import { Link } from "@/lib/i18n/navigation";
import { Badge } from "@/components/ui/badge";
import { PausedNote } from "@/components/explore/paused-note";
import { formatMoney, formatRating, formatTimeRange } from "@/lib/format";
import { nameInitial } from "@/lib/initials";
import { subjectAccentColor } from "@/lib/subject-accent";

export type ClassCardBadge = {
  variant: "success" | "warning" | "neutral" | "info";
  label: string;
};

export type ClassCardProps = {
  /** The class page — the subject name links to it. */
  href: string;
  subjectName: string | null;
  branchName: string;
  teacherName: string;
  /** Average out of 5, or null — never a count (docs/04 §10, §11.5). */
  teacherRating: number | null;
  gradeName: string | null;
  schedules: { dayOfWeek: number; startTime: string; endTime: string }[];
  /** Piastres per session. */
  price: number;
  badge: ClassCardBadge;
  /** The card's action slot (docs/04 §10): enrol / request / a status badge. */
  action: ReactNode;
  /** U5 — the branch is paused until this day (enrolment stays open). */
  pausedUntil?: Date | null;
};

/**
 * The class card (docs/04-design-system.md §10), shared by the public Explore
 * pages and the signed-in student Discover (F5) — one card, not a fork: each
 * caller decides the badge and the action, the card draws the rest.
 */
export async function ClassCard({
  href,
  subjectName,
  branchName,
  teacherName,
  teacherRating,
  gradeName,
  schedules,
  price,
  badge,
  action,
  pausedUntil,
}: ClassCardProps) {
  const locale = await getLocale();
  const t = await getTranslations("Explore.card");
  const tClasses = await getTranslations("Classes");
  const dayNames = tClasses.raw("dayNames") as string[];
  const accent = subjectAccentColor(subjectName);

  return (
    <div className="relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-surface p-4 pt-5 shadow-card transition-ui hover:border-border-strong hover:shadow-card-hover">
      <div aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={href}
            className="block truncate rounded-sm text-sm font-semibold text-text-primary focus-ring hover:text-brand hover:underline"
          >
            {subjectName ?? tClasses("columns.untitled")}
          </Link>
          <p className="truncate text-xs text-text-muted">{branchName}</p>
          {pausedUntil ? <PausedNote until={pausedUntil} /> : null}
        </div>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
          style={{ backgroundColor: accent }}
        >
          {nameInitial(teacherName)}
        </span>
        <span className="min-w-0 truncate text-sm text-text-secondary">{teacherName}</span>
        {teacherRating !== null ? (
          <span className="ms-auto shrink-0 text-xs font-medium text-text-muted">
            {t("rating", { value: formatRating(teacherRating, locale) })}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        {gradeName ? <span className="rounded-full border border-border px-2 py-0.5">{gradeName}</span> : null}
        {schedules.length > 0 ? (
          <span>
            {schedules
              .map((slot) => `${dayNames[slot.dayOfWeek]} ${formatTimeRange(slot.startTime, slot.endTime, locale)}`)
              .join(" · ")}
          </span>
        ) : (
          <span>{t("noSchedule")}</span>
        )}
      </div>

      <p className="text-sm font-semibold text-text-primary">{t("perSession", { price: formatMoney(price, locale) })}</p>

      <div className="mt-auto">{action}</div>
    </div>
  );
}

/** The card grid (docs/04 §10): one column below `md`, three from `lg`. */
export function ClassCardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">{children}</div>;
}
