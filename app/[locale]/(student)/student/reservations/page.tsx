import { getLocale, getTranslations } from "next-intl/server";
import { CalendarCheck, ClipboardList } from "lucide-react";

import { CancelBookingButton } from "@/app/[locale]/(student)/student/reservations/cancel-booking-button";
import { CancelReservationButton } from "@/app/[locale]/(student)/student/reservations/cancel-button";
import { EmptyState } from "@/components/shared/empty-state";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { ResultsRegion } from "@/components/shared/results-region";
import { SoftLink } from "@/components/shared/soft-link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requireStudentUser } from "@/lib/auth/tenant";
import { branchName } from "@/lib/branch-name";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { bookingDisplayStatus, type BookingDisplayStatus } from "@/lib/db/session-bookings";
import { isBookableNow } from "@/lib/db/session-seats";
import { listBookingsForStudent, listReservationsForStudent } from "@/lib/db/student-portal";
import { formatDate, formatTimeRange } from "@/lib/format";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";

const STATUS_BADGE = {
  PENDING: "warning",
  CONFIRMED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
} as const;

/** Booked = upcoming (blue), pending = amber, attended = green (docs/04 §2). */
const BOOKING_BADGE: Record<BookingDisplayStatus, "warning" | "info" | "success" | "danger" | "neutral"> = {
  PENDING: "warning",
  CONFIRMED: "info",
  ATTENDED: "success",
  EXPIRED: "neutral",
  REJECTED: "danger",
  CANCELLED: "neutral",
  CANCELLED_BY_BRANCH: "neutral",
  MOVED: "neutral",
};

const TABS = ["enrolments", "bookings"] as const;
type Tab = (typeof TABS)[number];

type LabelledClass = {
  subject: Parameters<typeof catalogLabelWithSelection>[1] | null;
  grade: Parameters<typeof catalogLabelWithSelection>[1] | null;
} | null;

/**
 * "My requests" (spec §4.3; F6 — was "My reservations"): two tabs, both
 * across every branch, read by the student's own id (`lib/db/student-portal.ts`):
 * **Class enrolments** — their `Reservation` requests, cancel while PENDING;
 * **Session bookings** — their single-session bookings, cancel while PENDING
 * or CONFIRMED and the session has not started. The tab is URL state
 * (`?tab=`), moved with `SoftLink` (T4): shareable, Back works, no reload.
 */
export default async function StudentRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await requireStudentUser();
  const { tab: rawTab } = await searchParams;
  const tab: Tab = rawTab === "bookings" ? "bookings" : "enrolments";

  const t = await getTranslations("StudentReservations");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();
  const now = new Date();

  const [reservations, bookings] = await Promise.all([
    listReservationsForStudent(prisma, session.user.id),
    listBookingsForStudent(prisma, session.user.id),
  ]);

  const classLabel = (classGroup: LabelledClass) =>
    [
      classGroup?.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
      classGroup?.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
    ]
      .filter(Boolean)
      .join(" · ") || tCommon("none");

  const counts: Record<Tab, number> = { enrolments: reservations.length, bookings: bookings.length };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle", { count: reservations.length + bookings.length })}
      />

      <nav aria-label={t("tabsLabel")} className="flex flex-wrap gap-2">
        {TABS.map((key) => (
          <SoftLink
            key={key}
            href={key === "enrolments" ? ROUTES.studentReservations : `${ROUTES.studentReservations}?tab=${key}`}
            aria-current={key === tab ? "page" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-ui-fast",
              key === tab
                ? "border-brand bg-brand text-brand-foreground"
                : "border-border bg-surface text-text-secondary hover:border-brand hover:text-text-primary",
            )}
          >
            {t(`tabs.${key}`)}
            <span className="tabular-nums">{counts[key]}</span>
          </SoftLink>
        ))}
      </nav>

      <ResultsRegion>
        <Card>
          <CardContent className="flex flex-col gap-3">
            {tab === "enrolments" ? (
              reservations.length === 0 ? (
                <EmptyState icon={<ClipboardList />} title={t("empty")} description={t("emptyHint")} />
              ) : (
                reservations.map((reservation) => (
                  <div
                    key={reservation.id}
                    className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {classLabel(reservation.classGroup)}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                        <span>{reservation.center.name}</span>
                        <span>{formatDate(reservation.requestedAt, locale)}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge variant={STATUS_BADGE[reservation.status]}>{t(`status.${reservation.status}`)}</Badge>
                      {reservation.status === "PENDING" ? (
                        <CancelReservationButton centerId={reservation.centerId} reservationId={reservation.id} />
                      ) : null}
                    </div>
                  </div>
                ))
              )
            ) : bookings.length === 0 ? (
              <EmptyState icon={<CalendarCheck />} title={t("bookingsEmpty")} description={t("bookingsEmptyHint")} />
            ) : (
              bookings.map((booking) => {
                const status = bookingDisplayStatus(booking, now);
                // Until the session starts (the server re-checks: `tooLate`).
                const cancellable =
                  (status === "PENDING" || status === "CONFIRMED") && isBookableNow(booking.session, now);
                const classId = booking.session.classGroupId;
                const movedTo = status === "MOVED" ? booking.session.rescheduledTo : null;
                return (
                  <div
                    key={booking.id}
                    className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {classLabel(booking.session.classGroup)}
                      </p>
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                        <span>{branchName(locale, booking.center)}</span>
                        <span>{formatDate(booking.session.date, locale)}</span>
                        <span dir="ltr" className="tabular-nums">
                          {formatTimeRange(booking.session.startTime, booking.session.endTime, locale)}
                        </span>
                      </p>
                      {movedTo ? (
                        <p className="text-xs text-text-secondary">
                          {t("movedTo", { date: formatDate(movedTo.date, locale) })}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-3">
                      <Badge variant={BOOKING_BADGE[status]}>{t(`bookingStatus.${status}`)}</Badge>
                      {cancellable ? <CancelBookingButton centerId={booking.centerId} bookingId={booking.id} /> : null}
                      {movedTo && classId ? (
                        <LinkButton href={ROUTES.studentDiscoverClass(booking.centerId, classId)} variant="outline">
                          {t("bookAgain")}
                        </LinkButton>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </ResultsRegion>
    </div>
  );
}
