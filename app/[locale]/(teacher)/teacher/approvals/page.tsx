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
import { QueueTabs } from "@/components/shared/queue-tabs";
import { RequestCard } from "@/components/shared/request-card";
import { ResultsRegion } from "@/components/shared/results-region";
import { SectionHeader } from "@/components/shared/section-header";
import { getPendingTeacherApprovalCounts } from "@/lib/auth/approval-counts";
import { ctxCan, requirePermission } from "@/lib/auth/tenant";
import { branchesInView, firstGranting, getTeacherScope } from "@/lib/auth/teacher-scope";
import { BranchFilter } from "@/components/teacher/branch-filter";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatTimeRange } from "@/lib/format";
import { fullName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";

/** The teacher's `?type=` tabs (F7); Enrolments is the bare URL. */
const TEACHER_APPROVALS_TABS = ["enrolments", "bookings"] as const;
type TeacherApprovalsTab = (typeof TEACHER_APPROVALS_TABS)[number];

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
 *
 * U7: across the branches in view that grant `reservation.manage.own` — a
 * branch that does not grant it contributes no rows, exactly as its own page
 * gate refused before — one scoped read per branch, unioned oldest first.
 * Each card names its branch and carries it to the action, which re-resolves
 * it and re-checks the grant there.
 */
export default async function TeacherApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; branch?: string }>;
}) {
  const scope = await getTeacherScope();
  const ctx = firstGranting(scope, "reservation.manage.own");
  await requirePermission(ctx, "reservation.manage.own");
  const granting = scope.inView.filter((branch) => ctxCan(branch, "reservation.manage.own"));
  const withBranch = granting.length > 1;

  const { type: rawType, branch: rawBranch } = await searchParams;
  const listed = branchesInView({ ...scope, inView: granting }, rawBranch);
  const branchFilter = withBranch && listed.length === 1 ? listed[0].center.id : null;
  // F7 — two tabs; Enrolments is the bare URL.
  const tab: TeacherApprovalsTab = rawType === "bookings" ? "bookings" : "enrolments";

  const t = await getTranslations("TeacherApprovals");
  const tScope = await getTranslations("TeacherScope");
  const locale = await getLocale();

  // The tabs, the header and the sidebar badge are one `pendingTeacherApprovalCounts`
  // read per branch — pinned to the classes this teacher teaches, like the rows below.
  const perBranch = await Promise.all(
    listed.map(async (branch) => {
      const db = scoped(branch);
      const [counts, reservations, bookings] = await Promise.all([
        getPendingTeacherApprovalCounts(branch),
        tab === "enrolments" ? db.reservations.listPendingForTeacher(branch.user.id) : [],
        // F6 — pinned to the classes this teacher teaches, like reservations.
        tab === "bookings" ? db.sessionBookings.listPending({ teacherId: branch.user.id }) : [],
      ]);
      return { branch: branch.center, counts, reservations, bookings };
    }),
  );
  const counts = {
    total: perBranch.reduce((sum, entry) => sum + entry.counts.total, 0),
    enrolments: perBranch.reduce((sum, entry) => sum + entry.counts.enrolments, 0),
    bookings: perBranch.reduce((sum, entry) => sum + entry.counts.bookings, 0),
  };
  // Oldest first across branches (F7).
  const reservations = perBranch
    .flatMap((entry) => entry.reservations.map((reservation) => ({ ...reservation, branch: entry.branch })))
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  const bookings = perBranch
    .flatMap((entry) => entry.bookings.map((booking) => ({ ...booking, branch: entry.branch })))
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  const branchDetail = (branch: { name: string }) => (withBranch ? [{ label: tScope("branch"), value: branch.name }] : []);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: counts.total })} />

      <QueueTabs
        tabs={TEACHER_APPROVALS_TABS.map((key) => ({
          key,
          label: t(`tabs.${key}`),
          count: counts[key],
        }))}
        active={tab}
        basePath={ROUTES.teacherApprovals}
        label={t("tabsLabel")}
        selectLabel={t("tabsSelectLabel")}
        allKey="enrolments"
      />

      {withBranch ? (
        <BranchFilter
          branches={granting.map((branch) => ({ id: branch.center.id, name: branch.center.name }))}
          value={branchFilter ?? ""}
        />
      ) : null}

      <ResultsRegion className="flex flex-col gap-6">
      {tab === "enrolments" ? (
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
                details={branchDetail(reservation.branch)}
                actions={<TeacherReservationActions id={reservation.id} centerId={reservation.branch.id} />}
              />
            );
          })
        )}
      </section>
      ) : (
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
                  ...branchDetail(booking.branch),
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
                    centerId={booking.branch.id}
                    approveAction={approveOwnBookingAction}
                    declineAction={declineOwnBookingAction}
                  />
                }
              />
            );
          })
        )}
      </section>
      )}
      </ResultsRegion>
    </div>
  );
}
