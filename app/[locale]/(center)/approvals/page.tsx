import { ClipboardCheck } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { ChangeRequestActions } from "@/app/[locale]/(center)/approvals/change-request-actions";
import { ReservationActions } from "@/app/[locale]/(center)/approvals/reservation-actions";
import { SessionRequestActions } from "@/app/[locale]/(center)/approvals/session-request-actions";
import { EmptyState } from "@/components/shared/empty-state";
import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { RequestCard } from "@/components/shared/request-card";
import { SectionHeader } from "@/components/shared/section-header";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatMoney, formatTimeRange } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";

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
export default async function ApprovalsPage() {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "approvals.manage");
  const db = scoped(ctx);

  const t = await getTranslations("Approvals");
  const tDays = await getTranslations("Classes");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();
  const dayNames = tDays.raw("dayNames") as string[];

  const [changeRequests, sessionRequests, reservations, subjects, grades, classGroups] =
    await Promise.all([
      db.changeRequests.list({ status: "PENDING", type: "NEW_CLASS" }),
      db.changeRequests.list({ status: "PENDING", type: "NEW_SESSION" }),
      db.reservations.listPending(),
      db.subjects.list(),
      db.grades.list(),
      db.classGroups.list(),
    ]);

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
    const users = await prisma.user.findMany({ where: { id: { in: unresolvedTeacherIds } } });
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
    const rows = await prisma.catalogSubject.findMany({ where: { id: { in: requestedSubjectIds } } });
    for (const row of rows) subjectNameById.set(row.id, catalogLabel(locale, row));
  }
  if (requestedGradeIds.length > 0) {
    const rows = await prisma.catalogGrade.findMany({ where: { id: { in: requestedGradeIds } } });
    for (const row of rows) gradeNameById.set(row.id, catalogLabel(locale, row));
  }
  const classGroupById = new Map(classGroups.map((classGroup) => [classGroup.id, classGroup]));

  const totalPending = changeRequests.length + sessionRequests.length + reservations.length;

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

      {totalPending === 0 ? (
        <EmptyState
          icon={<ClipboardCheck />}
          tone="success"
          title={t("empty")}
          description={t("emptyHint")}
        />
      ) : (
        <div className="flex flex-col gap-8">
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
                          value: String(payload.lateThresholdMinutes),
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
          </section>

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
          </section>

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
          </section>
        </div>
      )}
    </div>
  );
}
