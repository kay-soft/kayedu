import { ClipboardCheck } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { AccountClaimActions } from "@/app/[locale]/(center)/approvals/account-claim-actions";
import { ChangeRequestActions } from "@/app/[locale]/(center)/approvals/change-request-actions";
import { ReservationActions } from "@/app/[locale]/(center)/approvals/reservation-actions";
import { SessionRequestActions } from "@/app/[locale]/(center)/approvals/session-request-actions";
import { approveBookingAction, declineBookingAction } from "@/app/[locale]/(center)/approvals/actions";
import { BookingActions } from "@/components/center/booking-actions";
import { EmptyState } from "@/components/shared/empty-state";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import { QueueTabs } from "@/components/shared/queue-tabs";
import { RequestCard } from "@/components/shared/request-card";
import { ResultsRegion } from "@/components/shared/results-region";
import { SectionHeader } from "@/components/shared/section-header";
import { getPendingApprovalCounts } from "@/lib/auth/approval-counts";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import { pendingClaimsForCenter } from "@/lib/db/account-claims";
import { APPROVALS_PAGE_SIZE } from "@/lib/db/approvals";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatMoney, formatNumber, formatTimeRange } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { ROUTES } from "@/lib/routes";
import { usersByIds } from "@/lib/db/identity";
import { catalogGradesByIds, catalogSubjectsByIds } from "@/lib/db/catalog";

/** The `?type=` tabs (F7), in the order they are drawn. */
const APPROVALS_TABS = [
  "all",
  "classRequests",
  "sessionRequests",
  "enrolments",
  "bookings",
  "accountClaims",
] as const;
type ApprovalsTab = (typeof APPROVALS_TABS)[number];

type ChangeRequestPayload = {
  subjectId?: string | null;
  gradeId?: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  // R3: a pre-R3 request may still carry a `capacity` key in its JSON. It is
  // ignored — a class's seats come from its room set, chosen by the centre.
  lateThresholdMinutes: number;
  note?: string | null;
};

type SessionRequestPayload = {
  classGroupId: string;
  date: string;
  startTime: string;
  endTime: string;
  note?: string | null;
};

/**
 * The Approvals queue (spec §4.1 item 9): every PENDING `ChangeRequest`
 * (types NEW_CLASS and NEW_SESSION) and PENDING `Reservation` at the active
 * center, combined into one screen. OWNER/MANAGER only — `approvals.manage`
 * is not in RECEPTIONIST's baseline or grantable set (`lib/auth/permissions.ts`),
 * so a receptionist cannot reach this by UI or URL, the same pattern as
 * Analytics/Expenses (spec §7 acceptance criterion 9, M6).
 *
 * Accepting a NEW_CLASS `ChangeRequest` only flips its status — it does not
 * auto-create a `ClassGroup`. The request payload has no price, center-cut,
 * or room (`lib/validation/teacher.ts`'s `classRequestSchema`), all of which
 * only a center decides; auto-creating a class would mean guessing at money,
 * which CLAUDE.md rule 2 forbids outright. An approved request is staff's
 * cue to create the real class at `/classes`, reading these details off this
 * screen — see `docs/00-master-product-spec.md` §4.1 item 9 for the decision
 * record. A NEW_SESSION request (M10) is different: its `ClassGroup` already
 * exists with a decided price/cut, so accepting immediately creates the
 * `Session` (`lib/db/approvals.ts`'s `resolveSessionRequest`) — no money to
 * guess at, the same "approve == act" shape M8's `confirmReservation` uses.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "approvals.manage");
  const db = scoped(ctx);

  const { type: rawType } = await searchParams;
  const tab: ApprovalsTab = APPROVALS_TABS.find((key) => key === rawType) ?? "all";
  // Only the queues the selected tab shows are read; "All" reads every one.
  const shows = (...kinds: ApprovalsTab[]) => tab === "all" || kinds.includes(tab);

  const t = await getTranslations("Approvals");
  const tDays = await getTranslations("Classes");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();
  const dayNames = tDays.raw("dayNames") as string[];

  // F7 — every number on this screen (the tabs, the header, the "showing N of
  // M" notes) is one `pendingApprovalCounts` read, the same one the sidebar
  // badge shows, so none of them can disagree with the rows below.
  const counts = await getPendingApprovalCounts(ctx);

  // Oldest first in every queue: the request that has waited longest is on top.
  const page = { take: APPROVALS_PAGE_SIZE };
  const oldestFirst = { ...page, order: "asc" as const };
  const [
    changeRequests,
    sessionRequests,
    reservations,
    subjects,
    grades,
    classGroups,
    accountClaims,
    allBookings,
  ] = await Promise.all([
    shows("classRequests")
      ? db.changeRequests.list({ status: "PENDING", type: "NEW_CLASS" }, oldestFirst)
      : [],
    shows("sessionRequests")
      ? db.changeRequests.list({ status: "PENDING", type: "NEW_SESSION" }, oldestFirst)
      : [],
    shows("enrolments") ? db.reservations.listPending(page) : [],
    shows("classRequests", "sessionRequests") ? db.subjects.list() : [],
    shows("classRequests", "sessionRequests") ? db.grades.list() : [],
    shows("sessionRequests") ? db.classGroups.list() : [],
    shows("accountClaims") ? pendingClaimsForCenter(prisma, ctx.center.id) : [],
    // F6 — pending single-session bookings; an expired one is left out.
    shows("bookings") ? db.sessionBookings.listPending() : [],
  ]);
  const bookings = allBookings.slice(0, APPROVALS_PAGE_SIZE);
  // SEC-25: each queue shows one page; the rest wait behind it, counted.
  const moreNote = (shown: number, total: number) =>
    total > shown ? (
      <p className="text-sm text-text-secondary">{t("pageCapped", { shown, total })}</p>
    ) : null;

  const teacherIds = [
    ...new Set(
      [...changeRequests, ...sessionRequests].map((request) => request.requestedBy),
    ),
  ];
  const teacherMemberships = teacherIds.length > 0 ? await db.teachers.list({ userId: { in: teacherIds } }) : [];
  const teacherNameById = new Map(
    teacherMemberships.map((membership) => [
      membership.userId,
      fullName(localName(membership, membership.user)),
    ]),
  );
  // A teacher requesting to teach here for the first time (M15's centre
  // directory, `/teacher/centers`) has no local `Membership` record yet — the
  // lookup above only covers requesters who already teach at this centre —
  // so fall back to the person's global `User` name for anyone still missing.
  const unresolvedTeacherIds = teacherIds.filter((id) => !teacherNameById.has(id));
  if (unresolvedTeacherIds.length > 0) {
    const users = await usersByIds(prisma, unresolvedTeacherIds);
    for (const user of users) teacherNameById.set(user.id, fullName(user));
  }
  // `subjects`/`grades` come from `scoped(ctx)`'s catalog collections, which
  // already resolve `.name` to this centre's own display-name override (or
  // the catalog entry's bilingual name) — `catalogLabel` is for a raw
  // ClassGroup relation include below, which has no such override baked in.
  const subjectNameById = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const gradeNameById = new Map(grades.map((grade) => [grade.id, grade.name]));
  // A centre directory request (M15) may name a subject/grade this centre
  // has not picked into its own catalog yet — fall back to the canonical
  // global entry's own bilingual name rather than showing "none".
  const requestedSubjectIds = changeRequests
    .map((request) => (request.payload as unknown as ChangeRequestPayload).subjectId)
    .filter((id): id is string => Boolean(id) && !subjectNameById.has(id!));
  const requestedGradeIds = changeRequests
    .map((request) => (request.payload as unknown as ChangeRequestPayload).gradeId)
    .filter((id): id is string => Boolean(id) && !gradeNameById.has(id!));
  if (requestedSubjectIds.length > 0) {
    const rows = await catalogSubjectsByIds(prisma, requestedSubjectIds);
    for (const row of rows) subjectNameById.set(row.id, catalogLabel(locale, row));
  }
  if (requestedGradeIds.length > 0) {
    const rows = await catalogGradesByIds(prisma, requestedGradeIds);
    for (const row of rows) gradeNameById.set(row.id, catalogLabel(locale, row));
  }
  const classGroupById = new Map(classGroups.map((classGroup) => [classGroup.id, classGroup]));

  const totalPending = counts.total;
  const tabCounts: Record<ApprovalsTab, number> = {
    all: counts.total,
    classRequests: counts.classRequests,
    sessionRequests: counts.sessionRequests,
    enrolments: counts.enrolments,
    bookings: counts.bookings,
    accountClaims: counts.accountClaims,
  };

  // A NEW_CLASS request from someone with no local `Membership` is a teacher
  // asking to work at this branch at all (M15's centre directory), not an
  // existing teacher proposing another class. Same row in the database,
  // genuinely different decision — so it gets its own card kind and its own
  // note (docs/04 §11.3).
  const localTeacherIds = new Set(
    teacherMemberships.map((membership) => membership.userId),
  );

  const timeRange = (start: string, end: string) => formatTimeRange(start, end, locale);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: totalPending })} />

      <QueueTabs
        tabs={APPROVALS_TABS.map((key) => ({
          key,
          label: t(`tabs.${key}`),
          count: tabCounts[key],
        }))}
        active={tab}
        basePath={ROUTES.centerApprovals}
        label={t("tabsLabel")}
        selectLabel={t("tabsSelectLabel")}
      />

      <ResultsRegion>
      {tab === "all" && totalPending === 0 ? (
        <EmptyState
          icon={<ClipboardCheck />}
          tone="success"
          title={t("empty")}
          description={t("emptyHint")}
          action={
            <LinkButton href={ROUTES.centerTeachers}>{t("emptyAction")}</LinkButton>
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          {(tab === "all" && accountClaims.length > 0) || tab === "accountClaims" ? (
            <section className="flex flex-col gap-3">
              <SectionHeader
                title={t("accountClaims.title")}
                description={t("accountClaims.description")}
              />
              {accountClaims.length === 0 ? (
                <EmptyState
                  compact
                  icon={<ClipboardCheck />}
                  title={t("accountClaims.empty")}
                  description={t("accountClaims.emptyHint")}
                />
              ) : null}
              {accountClaims.map((claim) => (
                <RequestCard
                  key={claim.id}
                  kind="onboarding"
                  kindLabel={t("kinds.accountClaim")}
                  requesterName={claim.name}
                  headline={t(`accountClaims.headline.${claim.relation}`)}
                  requestedOn={t("changeRequests.requestedOn", {
                    date: formatDate(claim.createdAt, locale),
                  })}
                  details={[
                    { label: t("accountClaims.emailLabel"), value: claim.email, ltr: true },
                  ]}
                  note={t("accountClaims.inPerson")}
                  actions={<AccountClaimActions id={claim.id} />}
                />
              ))}
              {moreNote(accountClaims.length, counts.accountClaims)}
            </section>
          ) : null}

          {shows("classRequests") ? (
          <section className="flex flex-col gap-3">
            <SectionHeader
              title={t("changeRequests.title")}
              description={t("changeRequests.description")}
            />
            {changeRequests.length === 0 ? (
              <EmptyState
                compact
                icon={<ClipboardCheck />}
                title={t("changeRequests.empty")}
                description={t("changeRequests.emptyHint")}
              />
            ) : (
              changeRequests.map((request) => {
                const payload = request.payload as unknown as ChangeRequestPayload;
                const onboarding = !localTeacherIds.has(request.requestedBy);
                const subjectAndGrade = [
                  payload.subjectId ? subjectNameById.get(payload.subjectId) : null,
                  payload.gradeId ? gradeNameById.get(payload.gradeId) : null,
                ]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <div key={request.id} className="flex flex-col gap-2">
                    <RequestCard
                      kind={onboarding ? "onboarding" : "class"}
                      kindLabel={t(onboarding ? "kinds.onboarding" : "kinds.class")}
                      requesterName={
                        teacherNameById.get(request.requestedBy) ?? tCommon("none")
                      }
                      headline={[
                        onboarding
                          ? t("onboarding.headline")
                          : t("changeRequests.headline"),
                        subjectAndGrade,
                      ]
                        .filter(Boolean)
                        .join(" — ")}
                      requestedOn={t("changeRequests.requestedOn", {
                        date: formatDate(request.createdAt, locale),
                      })}
                      details={[
                        {
                          label: t("changeRequests.fields.day"),
                          value: dayNames[payload.dayOfWeek],
                        },
                        {
                          label: t("changeRequests.fields.time"),
                          value: timeRange(payload.startTime, payload.endTime),
                          ltr: true,
                        },
                        {
                          label: t("changeRequests.fields.lateThreshold"),
                          value: formatNumber(payload.lateThresholdMinutes, locale),
                        },
                      ]}
                      note={payload.note ?? null}
                      actions={<ChangeRequestActions id={request.id} />}
                    />
                    {onboarding ? (
                      <FormMessage tone="info" className="text-xs">
                        {t("onboarding.hint")}
                      </FormMessage>
                    ) : null}
                  </div>
                );
              })
            )}
            {moreNote(changeRequests.length, counts.classRequests)}
          </section>
          ) : null}

          {shows("sessionRequests") ? (
          <section className="flex flex-col gap-3">
            <SectionHeader
              title={t("sessionRequests.title")}
              description={t("sessionRequests.description")}
            />
            {sessionRequests.length === 0 ? (
              <EmptyState
                compact
                icon={<ClipboardCheck />}
                title={t("sessionRequests.empty")}
                description={t("sessionRequests.emptyHint")}
              />
            ) : (
              sessionRequests.map((request) => {
                const payload = request.payload as unknown as SessionRequestPayload;
                const classGroup = classGroupById.get(payload.classGroupId);
                const classLabel = classGroup
                  ? [
                      classGroup.subject
                        ? catalogLabelWithSelection(locale, classGroup.subject)
                        : null,
                      classGroup.grade
                        ? catalogLabelWithSelection(locale, classGroup.grade)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : t("sessionRequests.classGone");

                return (
                  <RequestCard
                    key={request.id}
                    kind="session"
                    kindLabel={t("kinds.session")}
                    requesterName={
                      teacherNameById.get(request.requestedBy) ?? tCommon("none")
                    }
                    headline={[t("sessionRequests.headline"), classLabel].join(" — ")}
                    requestedOn={t("changeRequests.requestedOn", {
                      date: formatDate(request.createdAt, locale),
                    })}
                    details={[
                      {
                        label: t("sessionRequests.fields.date"),
                        value: formatDate(
                          new Date(payload.date + "T00:00:00.000Z"),
                          locale,
                        ),
                      },
                      {
                        label: t("changeRequests.fields.time"),
                        value: timeRange(payload.startTime, payload.endTime),
                        ltr: true,
                      },
                    ]}
                    note={payload.note ?? null}
                    actions={<SessionRequestActions id={request.id} />}
                  />
                );
              })
            )}
            {moreNote(sessionRequests.length, counts.sessionRequests)}
          </section>
          ) : null}

          {shows("enrolments") ? (
          <section className="flex flex-col gap-3">
            <SectionHeader
              title={t("reservations.title")}
              description={t("reservations.description")}
            />
            {reservations.length === 0 ? (
              <EmptyState
                compact
                icon={<ClipboardCheck />}
                title={t("reservations.empty")}
                description={t("reservations.emptyHint")}
              />
            ) : (
              reservations.map((reservation) => {
                const classLabel =
                  [
                    reservation.classGroup.subject
                      ? catalogLabelWithSelection(locale, reservation.classGroup.subject)
                      : null,
                    reservation.classGroup.grade
                      ? catalogLabelWithSelection(locale, reservation.classGroup.grade)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || tCommon("none");

                return (
                  <RequestCard
                    key={reservation.id}
                    kind="reservation"
                    kindLabel={t("kinds.reservation")}
                    requesterName={fullName(reservation.student)}
                    headline={[t("reservations.headline"), classLabel].join(" — ")}
                    requestedOn={t("reservations.requestedOn", {
                      date: formatDate(reservation.requestedAt, locale),
                    })}
                    details={[
                      {
                        label: t("reservations.priceLabel"),
                        value: formatMoney(reservation.classGroup.price, locale),
                      },
                    ]}
                    actions={<ReservationActions id={reservation.id} />}
                  />
                );
              })
            )}
            {moreNote(reservations.length, counts.enrolments)}
          </section>
          ) : null}

          {shows("bookings") ? (
          <section className="flex flex-col gap-3">
            <SectionHeader title={t("bookings.title")} description={t("bookings.description")} />
            {bookings.length === 0 ? (
              <EmptyState
                compact
                icon={<ClipboardCheck />}
                title={t("bookings.empty")}
                description={t("bookings.emptyHint")}
              />
            ) : (
              bookings.map((booking) => {
                const classGroup = booking.session.classGroup;
                const classLabel =
                  [
                    classGroup?.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
                    classGroup?.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || tCommon("none");
                return (
                  <RequestCard
                    key={booking.id}
                    kind="booking"
                    kindLabel={t("kinds.booking")}
                    requesterName={fullName(booking.student)}
                    headline={[t("bookings.headline"), classLabel].join(" — ")}
                    requestedOn={t("reservations.requestedOn", {
                      date: formatDate(booking.requestedAt, locale),
                    })}
                    details={[
                      { label: t("sessionRequests.fields.date"), value: formatDate(booking.session.date, locale) },
                      {
                        label: t("changeRequests.fields.time"),
                        value: timeRange(booking.session.startTime, booking.session.endTime),
                        ltr: true,
                      },
                      { label: t("reservations.priceLabel"), value: formatMoney(booking.session.priceSnapshot, locale) },
                    ]}
                    actions={
                      <BookingActions
                        id={booking.id}
                        approveAction={approveBookingAction}
                        declineAction={declineBookingAction}
                      />
                    }
                  />
                );
              })
            )}
            {moreNote(bookings.length, counts.bookings)}
          </section>
          ) : null}
        </div>
      )}
      </ResultsRegion>
    </div>
  );
}
