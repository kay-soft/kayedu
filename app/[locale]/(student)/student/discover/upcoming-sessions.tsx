import { CalendarDays } from "lucide-react";
import type { SessionBookingMode, SessionBookingStatus } from "@prisma/client";
import { getLocale, getTranslations } from "next-intl/server";

import { BookSessionButton, MyBookingSlot } from "@/app/[locale]/(student)/student/discover/book-session-button";
import { seatBadge } from "@/components/explore/enrol-action";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { UpcomingSession } from "@/lib/db/session-bookings";
import { formatDate, formatTimeRange } from "@/lib/format";
import { sessionWhen, type JoinSummary } from "@/lib/join-summary";

/**
 * A class page's "Upcoming sessions" (F6, docs/04 §10): the next sessions
 * still open for booking, each with its date, time and seats (a status, never
 * a number) and — when the class allows it and the student is not enrolled —
 * "Attend this session only". The student's own booking on a session shows
 * in its place (Booked / Requested).
 */
export async function UpcomingSessions({
  centerId,
  sessions,
  mode,
  enrolled,
  myBookings,
  summary,
}: {
  centerId: string;
  sessions: UpcomingSession[];
  mode: SessionBookingMode;
  enrolled: boolean;
  myBookings: Map<string, { id: string; status: SessionBookingStatus }>;
  /** The class facts the booking confirmation states; each row adds its own `when`. */
  summary: JoinSummary;
}) {
  const locale = await getLocale();
  const t = await getTranslations("StudentDiscover.sessions");

  const note = enrolled ? t("enrolledNote") : mode === "OFF" ? t("offNote") : mode === "APPROVAL" ? t("approvalNote") : t("instantNote");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{note}</CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <EmptyState compact icon={<CalendarDays />} title={t("empty")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {await Promise.all(
              sessions.map(async (session) => {
                const mine = myBookings.get(session.id);
                const badge = await seatBadge(session.seats);
                let action = null;
                // U8 — the open booking carries its own Cancel (until the session
                // starts; these rows are only the not-yet-started ones).
                if (mine && (mine.status === "CONFIRMED" || mine.status === "PENDING")) {
                  action = <MyBookingSlot centerId={centerId} bookingId={mine.id} status={mine.status} />;
                } else if (!enrolled && mode !== "OFF" && session.seats !== "full") {
                  action = (
                    <BookSessionButton
                      centerId={centerId}
                      sessionId={session.id}
                      mode={mode}
                      summary={{ ...summary, when: sessionWhen(locale, session) }}
                    />
                  );
                }
                return (
                  <li
                    key={session.id}
                    className="flex flex-col gap-3 rounded-xl border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="text-sm font-medium text-text-primary">{formatDate(session.date, locale)}</p>
                      <p className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                        <span dir="ltr" className="tabular-nums">
                          {formatTimeRange(session.startTime, session.endTime, locale)}
                        </span>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </p>
                    </div>
                    {action ? <div className="shrink-0">{action}</div> : null}
                  </li>
                );
              }),
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
