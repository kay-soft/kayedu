import { ClipboardCheck } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { TeacherReservationActions } from "@/app/[locale]/(teacher)/teacher/approvals/reservation-actions";
import {
  approveOwnBookingAction,
  declineOwnBookingAction,
} from "@/app/[locale]/(teacher)/teacher/approvals/actions";
import { BookingActions } from "@/components/center/booking-actions";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { RequestCard } from "@/components/shared/request-card";
import { SectionHeader } from "@/components/shared/section-header";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatTimeRange } from "@/lib/format";
import { fullName } from "@/lib/identity";

/**
 * A teacher's own approvals queue (M15, spec §4.2 item 6): students
 * requesting to join *their* classes — a separate queue from the centre's
 * own `/approvals` (spec §4.1 item 9), because "do I want this student" is a
 * different decision from "does this fit our roster." Reads the exact same
 * `Reservation` rows, filtered to classes this teacher teaches
 * (`scoped(ctx).reservations.listPendingForTeacher`).
 *
 * Renders the same `RequestCard` queue the centre screen does, deliberately
 * (docs/04 §11.3): a teacher and a manager are reading the same kind of
 * request and should not have to learn two layouts.
 */
export default async function TeacherApprovalsPage() {
  const ctx = await getTenantContext("teacher");
  await requirePermission(ctx, "reservation.manage.own");
  const db = scoped(ctx);

  const t = await getTranslations("TeacherApprovals");
  const locale = await getLocale();

  const [reservations, bookings] = await Promise.all([
    db.reservations.listPendingForTeacher(ctx.user.id),
    // F6 — pinned to the classes this teacher teaches, like reservations.
    db.sessionBookings.listPending({ teacherId: ctx.user.id }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle", { count: reservations.length + bookings.length })}
      />

      <section className="flex flex-col gap-3">
        <SectionHeader title={t("listTitle")} description={t("listDescription")} />

        {reservations.length === 0 ? (
          <EmptyState
            icon={<ClipboardCheck />}
            tone="success"
            title={t("empty")}
            description={t("emptyHint")}
          />
        ) : (
          reservations.map((reservation) => {
            const classLabel = [
              reservation.classGroup.subject
                ? catalogLabelWithSelection(locale, reservation.classGroup.subject)
                : null,
              reservation.classGroup.grade
                ? catalogLabelWithSelection(locale, reservation.classGroup.grade)
                : null,
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <RequestCard
                key={reservation.id}
                kind="reservation"
                kindLabel={t("kindLabel")}
                requesterName={fullName(reservation.student)}
                headline={[t("headline"), classLabel].filter(Boolean).join(" — ")}
                requestedOn={t("requestedOn", {
                  date: formatDate(reservation.requestedAt, locale),
                })}
                actions={<TeacherReservationActions id={reservation.id} />}
              />
            );
          })
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader title={t("bookingsTitle")} description={t("bookingsDescription")} />
        {bookings.length === 0 ? (
          <EmptyState compact icon={<ClipboardCheck />} title={t("bookingsEmpty")} />
        ) : (
          bookings.map((booking) => {
            const classGroup = booking.session.classGroup;
            const classLabel = [
              classGroup?.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
              classGroup?.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <RequestCard
                key={booking.id}
                kind="booking"
                kindLabel={t("bookingKindLabel")}
                requesterName={fullName(booking.student)}
                headline={[t("bookingHeadline"), classLabel].filter(Boolean).join(" — ")}
                requestedOn={t("requestedOn", { date: formatDate(booking.requestedAt, locale) })}
                details={[
                  { label: t("bookingDate"), value: formatDate(booking.session.date, locale) },
                  {
                    label: t("bookingTime"),
                    value: formatTimeRange(booking.session.startTime, booking.session.endTime, locale),
                    ltr: true,
                  },
                ]}
                actions={
                  <BookingActions
                    id={booking.id}
                    approveAction={approveOwnBookingAction}
                    declineAction={declineOwnBookingAction}
                  />
                }
              />
            );
          })
        )}
      </section>
    </div>
  );
}
