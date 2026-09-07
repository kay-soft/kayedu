import { getLocale, getTranslations } from "next-intl/server";

import { ChangeRequestActions } from "@/app/[locale]/(center)/approvals/change-request-actions";
import { ReservationActions } from "@/app/[locale]/(center)/approvals/reservation-actions";
import { SessionRequestActions } from "@/app/[locale]/(center)/approvals/session-request-actions";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { scoped } from "@/lib/db/scoped";
import { formatDate, formatMoney } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";

type ChangeRequestPayload = {
  subjectId?: string | null;
  gradeId?: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  capacity: number;
  attendanceRequired: boolean;
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

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: totalPending })} />

      {totalPending === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-text-muted">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("changeRequests.title")}</CardTitle>
              <CardDescription>{t("changeRequests.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {changeRequests.length === 0 ? (
                <p className="text-sm text-text-muted">{t("changeRequests.empty")}</p>
              ) : (
                changeRequests.map((request) => {
                  const payload = request.payload as unknown as ChangeRequestPayload;
                  return (
                    <div
                      key={request.id}
                      className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary">
                          {teacherNameById.get(request.requestedBy) ?? tCommon("none")}
                        </p>
                        <p className="mt-1 text-xs text-text-secondary">
                          {[
                            payload.subjectId ? subjectNameById.get(payload.subjectId) : null,
                            payload.gradeId ? gradeNameById.get(payload.gradeId) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || tCommon("none")}
                        </p>
                        <p className="mt-1 text-xs text-text-muted">
                          {t("changeRequests.requestedOn", { date: formatDate(request.createdAt, locale) })}
                        </p>
                        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-secondary sm:grid-cols-3">
                          <div>
                            <dt className="text-text-muted">{t("changeRequests.fields.day")}</dt>
                            <dd>{dayNames[payload.dayOfWeek]}</dd>
                          </div>
                          <div>
                            <dt className="text-text-muted">{t("changeRequests.fields.time")}</dt>
                            <dd dir="ltr">
                              {payload.startTime}–{payload.endTime}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-text-muted">{t("changeRequests.fields.capacity")}</dt>
                            <dd>{payload.capacity || tCommon("none")}</dd>
                          </div>
                          <div>
                            <dt className="text-text-muted">{t("changeRequests.fields.attendance")}</dt>
                            <dd>{payload.attendanceRequired ? t("changeRequests.fields.yes") : t("changeRequests.fields.no")}</dd>
                          </div>
                          <div>
                            <dt className="text-text-muted">{t("changeRequests.fields.lateThreshold")}</dt>
                            <dd>{payload.lateThresholdMinutes}</dd>
                          </div>
                        </dl>
                        {payload.note ? (
                          <p className="mt-2 text-xs text-text-secondary">{payload.note}</p>
                        ) : null}
                      </div>
                      <ChangeRequestActions id={request.id} />
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("sessionRequests.title")}</CardTitle>
              <CardDescription>{t("sessionRequests.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {sessionRequests.length === 0 ? (
                <p className="text-sm text-text-muted">{t("sessionRequests.empty")}</p>
              ) : (
                sessionRequests.map((request) => {
                  const payload = request.payload as unknown as SessionRequestPayload;
                  const classGroup = classGroupById.get(payload.classGroupId);
                  return (
                    <div
                      key={request.id}
                      className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary">
                          {teacherNameById.get(request.requestedBy) ?? tCommon("none")}
                        </p>
                        <p className="mt-1 text-xs text-text-secondary">
                          {classGroup
                            ? [
                                classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : null,
                                classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            : t("sessionRequests.classGone")}
                        </p>
                        <p className="mt-1 text-xs text-text-muted">
                          {t("changeRequests.requestedOn", { date: formatDate(request.createdAt, locale) })}
                        </p>
                        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-secondary sm:grid-cols-3">
                          <div>
                            <dt className="text-text-muted">{t("sessionRequests.fields.date")}</dt>
                            <dd>{formatDate(new Date(`${payload.date}T00:00:00.000Z`), locale)}</dd>
                          </div>
                          <div>
                            <dt className="text-text-muted">{t("changeRequests.fields.time")}</dt>
                            <dd dir="ltr">
                              {payload.startTime}–{payload.endTime}
                            </dd>
                          </div>
                        </dl>
                        {payload.note ? (
                          <p className="mt-2 text-xs text-text-secondary">{payload.note}</p>
                        ) : null}
                      </div>
                      <SessionRequestActions id={request.id} />
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("reservations.title")}</CardTitle>
              <CardDescription>{t("reservations.description")}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {reservations.length === 0 ? (
                <p className="text-sm text-text-muted">{t("reservations.empty")}</p>
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
                          reservation.classGroup.subject ? catalogLabelWithSelection(locale, reservation.classGroup.subject) : null,
                          reservation.classGroup.grade ? catalogLabelWithSelection(locale, reservation.classGroup.grade) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || tCommon("none")}
                      </p>
                      <p className="mt-1 text-xs text-text-muted">
                        {t("reservations.requestedOn", { date: formatDate(reservation.requestedAt, locale) })}
                      </p>
                      <p className="mt-1 text-xs text-text-muted">
                        {formatMoney(reservation.classGroup.price, locale)}
                      </p>
                    </div>
                    <ReservationActions id={reservation.id} />
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
