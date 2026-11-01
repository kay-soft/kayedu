import type React from "react";
import { CalendarSearch, ChevronLeft, ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/shared/empty-state";
import { ResultsRegion } from "@/components/shared/results-region";
import { SoftLink } from "@/components/shared/soft-link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/lib/i18n/navigation";
import {
  CALENDAR_DOTS,
  calendarGrid,
  monthKey,
  shiftMonth,
  type CalendarTone,
} from "@/lib/calendar";
import {
  calendarWeekStart,
  formatDayOfMonth,
  formatFullDate,
  formatMonthYear,
  formatNumber,
  formatWeekdayNarrow,
} from "@/lib/format";
import { dateKey } from "@/lib/scheduling";
import { cn } from "@/lib/utils";

/** One session on the calendar, already labelled by the page. */
export type CalendarEntry = {
  id: string;
  /** "YYYY-MM-DD" — the session's own calendar day. */
  day: string;
  tone: CalendarTone;
  /** "16:00 – 18:00", formatted for the locale. */
  time: string;
  /** For ordering within a day. */
  startTime: string;
  /** The class's subject · grade, or a one-time session's title. */
  title: string;
  branch: string | null;
  room: string | null;
  /** Teacher only: the session page. */
  href?: string;
  /** Teacher only: present / late / absent on this session. */
  counts?: { present: number; late: number; absent: number };
  /**
   * Student only (U8): the row's own undo — "Leave class" on an enrolled
   * session, "Cancel booking" on a booked one. Never set for a parent or a
   * teacher; a row with `href` is a link and cannot carry one.
   */
  actions?: React.ReactNode;
};

/**
 * Each tone's dot — semantic tokens only (docs/04 §2, CLAUDE.md rule 8):
 * present/held green, late amber, absent red, upcoming blue; a booked single
 * session is a blue **ring**, a requested one a dashed amber ring, cancelled
 * grey. A dot is never the only signal: every row below carries a text badge,
 * and the legend names each mark.
 */
const DOT: Record<CalendarTone, string> = {
  present: "bg-success",
  held: "bg-success",
  late: "bg-warning",
  absent: "bg-danger",
  upcoming: "bg-info",
  booked: "border-[1.5px] border-info bg-transparent",
  requested: "border-[1.5px] border-dashed border-warning bg-transparent",
  cancelled: "bg-text-muted",
};

const BADGE: Record<CalendarTone, "success" | "warning" | "danger" | "info" | "neutral"> = {
  present: "success",
  held: "success",
  late: "warning",
  absent: "danger",
  upcoming: "info",
  booked: "info",
  requested: "warning",
  cancelled: "neutral",
};

function Dot({ tone, className }: { tone: CalendarTone; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[tone], className)} />;
}

/**
 * The month calendar (U7, docs/04-design-system.md §11.28) — one component
 * for the student, teacher and parent calendars. A month grid opening on the
 * app's week start (`calendarWeekStart`: Saturday in Arabic, Sunday in
 * English), today outlined, previous / next and Today. Each day shows up to
 * three coloured dots and "+n"; tapping a day lists its sessions under the
 * grid on the same page. All state is the URL (`?month=YYYY-MM&day=YYYY-MM-DD`,
 * plus `keep` — a parent's `child`, a teacher's `branch`), moved with
 * `SoftLink`s so the page updates in place (T4, docs/02 §14).
 *
 * Phone first: at 375px the grid is dots only, each day a 44px target, the
 * day's list below; the cells grow from `sm`.
 */
export async function SessionCalendar({
  locale,
  basePath,
  keep = {},
  month,
  selectedDay,
  todayKey,
  entries,
  legend,
  emptyMonthHint,
  region = true,
}: {
  locale: string;
  basePath: string;
  keep?: Record<string, string | undefined>;
  /** The first of the month shown. */
  month: Date;
  selectedDay: string | null;
  todayKey: string;
  entries: CalendarEntry[];
  /** The tones this calendar can show, in legend order. */
  legend: CalendarTone[];
  /** Shown under the grid when the month has nothing at all. */
  emptyMonthHint: string;
  /**
   * Dim the grid and the day list while the next URL loads (`ResultsRegion`).
   * Off when the page already wraps the calendar in its own region — the
   * parent's, whose child selector changes the whole calendar.
   */
  region?: boolean;
}) {
  const Region = region ? ResultsRegion : PlainRegion;
  const t = await getTranslations("Calendar");

  const href = (params: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...keep, ...params })) if (value) query.set(key, value);
    const qs = query.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of entries) byDay.set(entry.day, [...(byDay.get(entry.day) ?? []), entry]);
  for (const list of byDay.values()) list.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.title.localeCompare(b.title));

  const days = calendarGrid(month, calendarWeekStart(locale));
  const shownMonth = monthKey(month);
  const todayMonth = todayKey.slice(0, 7);
  const dayList = selectedDay ? (byDay.get(selectedDay) ?? []) : [];

  const navButton =
    "flex size-11 shrink-0 items-center justify-center rounded-lg border border-border text-text-primary transition-ui focus-ring hover:border-border-strong hover:bg-surface-hover active:bg-surface-active";

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="gap-3">
          <div className="flex items-center gap-2">
            <SoftLink
              href={href({ month: monthKey(shiftMonth(month, -1)) })}
              aria-label={t("previousMonth")}
              className={navButton}
            >
              {/* The arrow means "previous": it mirrors in RTL (docs/04 §7). */}
              <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden />
            </SoftLink>
            <h2 className="min-w-0 flex-1 text-center text-base font-semibold text-text-primary" aria-live="polite">
              {formatMonthYear(month, locale)}
            </h2>
            <SoftLink
              href={href({ month: monthKey(shiftMonth(month, 1)) })}
              aria-label={t("nextMonth")}
              className={navButton}
            >
              <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden />
            </SoftLink>
            <SoftLink
              href={href({ month: todayMonth, day: todayKey })}
              className="flex h-11 shrink-0 items-center justify-center rounded-lg border border-border px-3 text-sm font-medium text-text-primary transition-ui focus-ring hover:border-border-strong hover:bg-surface-hover active:bg-surface-active"
            >
              {t("today")}
            </SoftLink>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4 px-2 sm:px-(--card-spacing)">
          <Region className="flex flex-col gap-1">
            <div className="grid grid-cols-7 sm:gap-1" aria-hidden>
              {days.slice(0, 7).map((day) => (
                <span key={dateKey(day)} className="py-1 text-center text-xs font-medium text-text-muted">
                  {formatWeekdayNarrow(day, locale)}
                </span>
              ))}
            </div>
            <ol className="grid grid-cols-7 sm:gap-1" aria-label={formatMonthYear(month, locale)}>
              {days.map((day) => {
                const key = dateKey(day);
                const inMonth = key.startsWith(shownMonth);
                const list = byDay.get(key) ?? [];
                const isToday = key === todayKey;
                const isSelected = key === selectedDay;
                const label = [
                  formatFullDate(day, locale),
                  isToday ? t("todayMarker") : null,
                  t("sessionCount", { count: list.length, formatted: formatNumber(list.length, locale) }),
                ]
                  .filter(Boolean)
                  .join(", ");
                const extra = list.length - CALENDAR_DOTS;
                return (
                  <li key={key} className="min-w-0">
                    <SoftLink
                      href={href({ month: key.slice(0, 7), day: key })}
                      aria-label={label}
                      aria-current={isSelected ? "true" : undefined}
                      className={cn(
                        "flex min-h-11 w-full flex-col items-center justify-center gap-1 rounded-lg border border-transparent p-0.5 transition-ui focus-ring sm:min-h-16 sm:p-1",
                        "hover:bg-surface-hover active:bg-surface-active",
                        inMonth ? "text-text-primary" : "text-text-muted",
                        isToday && "border-brand",
                        isSelected && "bg-brand/10 font-semibold text-brand",
                      )}
                    >
                      <span className="text-sm leading-none tabular-nums">{formatDayOfMonth(day, locale)}</span>
                      <span className="flex h-2.5 items-center justify-center gap-0.5">
                        {list.slice(0, CALENDAR_DOTS).map((entry) => (
                          <Dot key={entry.id} tone={entry.tone} />
                        ))}
                        {extra > 0 ? (
                          <span className="text-[10px] leading-none text-text-secondary">
                            {t("more", { count: extra, formatted: formatNumber(extra, locale) })}
                          </span>
                        ) : null}
                      </span>
                    </SoftLink>
                  </li>
                );
              })}
            </ol>
          </Region>

          <ul aria-label={t("legend")} className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-3 text-xs text-text-secondary">
            {legend.map((tone) => (
              <li key={tone} className="flex items-center gap-1.5">
                <Dot tone={tone} />
                <span className={cn(tone === "cancelled" && "line-through")}>{t(`tone.${tone}`)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {selectedDay ? formatFullDate(new Date(`${selectedDay}T00:00:00.000Z`), locale) : t("pickDayTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Region>
            {!selectedDay ? (
              <EmptyState compact icon={<CalendarSearch />} title={t("pickDay")} description={entries.length === 0 ? emptyMonthHint : undefined} />
            ) : dayList.length === 0 ? (
              <EmptyState compact icon={<CalendarSearch />} title={t("noSessions")} description={entries.length === 0 ? emptyMonthHint : undefined} />
            ) : (
              <ul className="flex flex-col gap-2">
                {dayList.map((entry) => (
                  <li key={entry.id}>
                    <DayRow entry={entry} statusLabel={t(`tone.${entry.tone}`)} countsLabel={
                      entry.counts
                        ? t("counts", {
                            present: formatNumber(entry.counts.present, locale),
                            late: formatNumber(entry.counts.late, locale),
                            absent: formatNumber(entry.counts.absent, locale),
                          })
                        : null
                    } openLabel={t("openSession")} />
                  </li>
                ))}
              </ul>
            )}
          </Region>
        </CardContent>
      </Card>
    </div>
  );
}

function PlainRegion({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={className}>{children}</div>;
}

function DayRow({
  entry,
  statusLabel,
  countsLabel,
  openLabel,
}: {
  entry: CalendarEntry;
  statusLabel: string;
  countsLabel: string | null;
  openLabel: string;
}) {
  const cancelled = entry.tone === "cancelled";
  const body = (
    <>
      <div className="flex min-w-0 items-start gap-3">
        <Dot tone={entry.tone} className="mt-1.5" />
        <div className="min-w-0">
          <p className={cn("text-sm font-semibold text-text-primary", cancelled && "text-text-secondary line-through")}>
            {entry.title}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
            <span className="tabular-nums">{entry.time}</span>
            {entry.branch ? <span className="font-medium">{entry.branch}</span> : null}
            {entry.room ? <span>{entry.room}</span> : null}
          </p>
          {countsLabel ? <p className="mt-1 text-xs text-text-muted">{countsLabel}</p> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <Badge
          variant={BADGE[entry.tone]}
          className={cn(
            entry.tone === "booked" && "border border-info bg-transparent",
            entry.tone === "requested" && "border border-dashed border-warning",
            cancelled && "line-through",
          )}
        >
          {statusLabel}
        </Badge>
        {entry.href ? <span className="sr-only">{openLabel}</span> : null}
        {!entry.href && entry.actions ? entry.actions : null}
      </div>
    </>
  );
  const frame = "flex flex-col gap-2 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between";
  return entry.href ? (
    <Link href={entry.href} className={cn(frame, "min-h-11 transition-ui focus-ring hover:border-border-strong hover:shadow-card-hover")}>
      {body}
    </Link>
  ) : (
    <div className={frame}>{body}</div>
  );
}
