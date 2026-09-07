import { getLocale, getTranslations } from "next-intl/server";

import { TeacherReservationActions } from "@/app/[locale]/(teacher)/teacher/approvals/reservation-actions";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { scoped } from "@/lib/db/scoped";
import { formatDate } from "@/lib/format";
import { fullName } from "@/lib/identity";

/**
 * A teacher's own approvals queue (M15, spec §4.2 item 6): students
 * requesting to join *their* classes — a separate queue from the centre's
 * own `/approvals` (spec §4.1 item 9), because "do I want this student" is a
 * different decision from "does this fit our roster." Reads the exact same
 * `Reservation` rows, filtered to classes this teacher teaches
 * (`scoped(ctx).reservations.listPendingForTeacher`).
 */
export default async function TeacherApprovalsPage() {
  const ctx = await getTenantContext("teacher");
  await requirePermission(ctx, "reservation.manage.own");
  const db = scoped(ctx);

  const t = await getTranslations("TeacherApprovals");
  const locale = await getLocale();

  const reservations = await db.reservations.listPendingForTeacher(ctx.user.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: reservations.length })} />

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle")}</CardTitle>
          <CardDescription>{t("listDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {reservations.length === 0 ? (
            <p className="text-sm text-text-muted">{t("empty")}</p>
          ) : (
            reservations.map((reservation) => (
              <div
                key={reservation.id}
                className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-primary">
                    {fullName(reservation.student)}
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    {[
                      reservation.classGroup.subject
                        ? catalogLabelWithSelection(locale, reservation.classGroup.subject)
                        : null,
                      reservation.classGroup.grade
                        ? catalogLabelWithSelection(locale, reservation.classGroup.grade)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    {t("requestedOn", { date: formatDate(reservation.requestedAt, locale) })}
                  </p>
                </div>
                <TeacherReservationActions id={reservation.id} />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
