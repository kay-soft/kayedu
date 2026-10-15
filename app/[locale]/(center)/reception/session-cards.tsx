"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Clock, DoorOpen, Play, Receipt, Search, UserRound, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { EndSessionButton } from "@/app/[locale]/(center)/sessions/[id]/end-session-button";
import { ActionBar } from "@/components/shared/action-bar";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { ReceptionSessionCard } from "@/lib/db/reception";
import { formatNumber, formatTimeRange } from "@/lib/format";
import { Link, useRouter } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

type StatusFilter = "ALL" | "LIVE" | "SCHEDULED" | "COMPLETED";
const FILTERS: StatusFilter[] = ["ALL", "LIVE", "SCHEDULED", "COMPLETED"];

/** Cards cross the server→client boundary as plain data (no Dates, no functions). */
export type SessionCardData = Pick<
  ReceptionSessionCard,
  | "id"
  | "label"
  | "teacherName"
  | "startTime"
  | "endTime"
  | "rooms"
  | "displayStatus"
  | "autoClosed"
  | "checkedIn"
  | "canAttend"
  | "end"
  | "canViewReceipt"
>;

/** The reception desk shows three states; a cancelled or rescheduled session never reaches it. */
function statusKey(card: SessionCardData): "LIVE" | "SCHEDULED" | "COMPLETED" | "autoClosed" {
  if (card.displayStatus === "LIVE") return "LIVE";
  if (card.displayStatus === "SCHEDULED") return "SCHEDULED";
  return card.autoClosed ? "autoClosed" : "COMPLETED";
}

/** `/reception` plus whichever of `session` / `receipt` are given. */
function receptionHref(params: { session?: string | null; receipt?: string | null }): string {
  const query = new URLSearchParams();
  if (params.session) query.set("session", params.session);
  if (params.receipt) query.set("receipt", params.receipt);
  const text = query.toString();
  return text ? `${ROUTES.centerReception}?${text}` : ROUTES.centerReception;
}

/**
 * Today's sessions (R7): one card per session — name, teacher, time, rooms,
 * a status badge and the checked-in count — with a quick status filter and a
 * client-side text filter on name/teacher. The list is already ordered (Live,
 * then upcoming by start time, then ended) by `loadReceptionSessions`; the
 * filters only hide cards, they never reorder them. Actions follow the R6
 * action-bar pattern (44px, same spacing): **Start attending** enters session
 * mode (`?session=`), **End session** is R2's own `EndSessionButton` (so one
 * dialog, one `endSessionAction`), and an ended card offers **View receipt**,
 * which is a soft navigation to `?receipt=` — no page reload.
 */
export function SessionCards({
  cards,
  attendingId,
}: {
  cards: SessionCardData[];
  /** The session in session mode, if any (already validated by the server). */
  attendingId: string | null;
}) {
  const t = useTranslations("Reception");
  const locale = useLocale();
  const router = useRouter();
  const [filter, setFilter] = useState<StatusFilter>("ALL");
  const [text, setText] = useState("");

  const visible = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return cards.filter((card) => {
      if (filter !== "ALL" && card.displayStatus !== filter) return false;
      if (needle.length === 0) return true;
      return `${card.label} ${card.teacherName ?? ""}`.toLowerCase().includes(needle);
    });
  }, [cards, filter, text]);

  if (cards.length === 0) {
    return (
      <EmptyState
        compact
        icon={<CalendarClock />}
        title={t("noSessionsToday")}
        description={t("noSessionsTodayHint")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* One row of four segments, even at 375 (docs/04 §14.5). */}
        <div role="group" aria-label={t("filters.label")} className="grid grid-cols-4 gap-1.5 sm:flex sm:flex-wrap sm:gap-2">
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "inline-flex h-11 min-w-0 items-center justify-center rounded-lg border px-2 text-sm font-medium whitespace-nowrap transition-ui focus-ring sm:px-4",
                filter === value
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-border-control bg-surface text-text-secondary hover:border-border-control-hover hover:bg-surface-hover active:bg-surface-active",
              )}
            >
              {t(`filters.${value}`)}
            </button>
          ))}
        </div>
        <div className="relative w-full lg:max-w-xs">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-text-muted"
            aria-hidden
          />
          <Input
            type="search"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            placeholder={t("filters.textPlaceholder")}
            aria-label={t("filters.textLabel")}
            className="ps-9"
            maxLength={60}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState compact icon={<Search />} tone="warning" title={t("filters.noMatches")} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((card) => {
            const attending = card.id === attendingId;
            const live = card.displayStatus === "LIVE";
            return (
              <li
                key={card.id}
                className={cn(
                  "flex flex-col gap-3 rounded-xl border bg-surface p-4",
                  attending ? "border-brand ring-2 ring-brand/30" : "border-border",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={ROUTES.centerSession(card.id)}
                    className="min-w-0 rounded-sm text-base font-semibold text-text-primary focus-ring hover:text-brand hover:underline"
                  >
                    <span className="line-clamp-2">{card.label}</span>
                  </Link>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge
                      variant={live ? "success" : card.displayStatus === "SCHEDULED" ? "info" : "neutral"}
                      pulse={live}
                    >
                      {t(`status.${statusKey(card)}`)}
                    </Badge>
                    {/* The card being attended says so in its header — the
                        button-shaped chip it replaced read as disabled. */}
                    {attending ? <Badge variant="brand">{t("card.attending")}</Badge> : null}
                  </div>
                </div>

                <dl className="flex flex-col gap-1.5 text-sm text-text-secondary">
                  <div className="flex items-center gap-2">
                    <UserRound className="size-4 shrink-0 text-text-muted" aria-hidden />
                    <dt className="sr-only">{t("card.teacher")}</dt>
                    <dd className="min-w-0 truncate">{card.teacherName ?? "—"}</dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="size-4 shrink-0 text-text-muted" aria-hidden />
                    <dt className="sr-only">{t("card.time")}</dt>
                    <dd className="tabular-nums" suppressHydrationWarning>
                      {formatTimeRange(card.startTime, card.endTime, locale)}
                    </dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <DoorOpen className="size-4 shrink-0 text-text-muted" aria-hidden />
                    <dt className="sr-only">{t("card.rooms")}</dt>
                    <dd className="min-w-0 truncate">{card.rooms.join(" + ") || "—"}</dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <Users className="size-4 shrink-0 text-text-muted" aria-hidden />
                    <dt className="text-text-secondary">{t("card.checkedIn")}</dt>
                    <dd className="font-semibold tabular-nums text-text-primary">
                      {formatNumber(card.checkedIn, locale)}
                    </dd>
                  </div>
                </dl>

                <div className="mt-auto flex flex-col gap-2 border-t border-border-subtle pt-3">
                  {/* Two equal columns at every width inside a card, so action rows
                      line up across the grid; a lone verb spans both. Start
                      attending is the primary only on a live card (§14.5). */}
                  <ActionBar className="sm:grid sm:grid-cols-2 [&>*:only-child]:col-span-2">
                    {card.canAttend && !attending ? (
                      <LinkButton
                        variant={live ? "default" : "outline"}
                        href={receptionHref({ session: card.id })}
                        className="w-full"
                      >
                        <Play className="size-4" aria-hidden />
                        {t("card.startAttending")}
                      </LinkButton>
                    ) : null}
                    {/* Only once it can be used: an upcoming card's disabled
                        End session and its hint were noise on every card. */}
                    {card.end === "enabled" ? (
                      <EndSessionButton
                        sessionId={card.id}
                        className="sm:w-full"
                        onClosed={() =>
                          router.push(
                            receptionHref({
                              // Ending the session being attended leaves session mode.
                              session: attending ? null : attendingId,
                              receipt: card.id,
                            }),
                          )
                        }
                      />
                    ) : null}
                    {card.canViewReceipt ? (
                      <LinkButton
                        href={receptionHref({ session: attendingId, receipt: card.id })}
                        className="w-full"
                      >
                        <Receipt className="size-4" aria-hidden />
                        {t("card.viewReceipt")}
                      </LinkButton>
                    ) : null}
                  </ActionBar>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
