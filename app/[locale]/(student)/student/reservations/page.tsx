import { getLocale, getTranslations } from "next-intl/server";

import { CancelReservationButton } from "@/app/[locale]/(student)/student/reservations/cancel-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requireStudentUser } from "@/lib/auth/tenant";
import { catalogLabel } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { listReservationsForStudent } from "@/lib/db/student-portal";
import { formatDate } from "@/lib/format";

const STATUS_BADGE = {
  PENDING: "warning",
  CONFIRMED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
} as const;

/**
 * "My reservations" (spec §4.3 item 3): every request this student has ever
 * made, across every center — read by their own `studentId`, not a single
 * `centerId` (see the doc comment on `lib/db/student-portal.ts`).
 */
export default async function StudentReservationsPage() {
  const session = await requireStudentUser();
  const t = await getTranslations("StudentReservations");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const reservations = await listReservationsForStudent(prisma, session.user.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: reservations.length })} />

      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          {reservations.length === 0 ? (
            <p className="text-sm text-text-muted">{t("empty")}</p>
          ) : (
            reservations.map((reservation) => (
              <div
                key={reservation.id}
                className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    {[
                      reservation.classGroup.subject ? catalogLabel(locale, reservation.classGroup.subject) : null,
                      reservation.classGroup.grade ? catalogLabel(locale, reservation.classGroup.grade) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || tCommon("none")}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                    <span>{reservation.center.name}</span>
                    <span>{formatDate(reservation.requestedAt, locale)}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Badge variant={STATUS_BADGE[reservation.status]}>
                    {t(`status.${reservation.status}`)}
                  </Badge>
                  {reservation.status === "PENDING" ? (
                    <CancelReservationButton
                      centerId={reservation.centerId}
                      reservationId={reservation.id}
                    />
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
