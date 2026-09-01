import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { AddAttendeePanel, type AttendeeCandidate } from "@/app/[locale]/(center)/sessions/[id]/add-attendee-panel";
import { SessionReceipt } from "@/app/[locale]/(center)/sessions/[id]/session-receipt";
import { SessionRoster, type RosterRowData } from "@/app/[locale]/(center)/sessions/[id]/session-roster";
import { SearchBox } from "@/components/center/search-box";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { consecutiveAbsenceCount } from "@/lib/db/attendance";
import { prisma } from "@/lib/db/client";
import { sessionReceiptTotals } from "@/lib/db/payments";
import { scoped } from "@/lib/db/scoped";
import { deriveSessionDisplayStatus, sessionDisplayName } from "@/lib/db/sessions";
import { studentSearchWhere } from "@/lib/db/students";
import { formatDate, formatMoney } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

const MAX_CANDIDATES = 8;

const STATUS_BADGE = {
  SCHEDULED: "info",
  LIVE: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
} as const;

/**
 * One session's roster, attendance and receipt (spec §4.1 item 7). The id in
 * the URL resolves through the scoped helper, so a session id from another
 * center resolves to "not found", never a row (docs/02 §5).
 */
export default async function SessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "session.view");

  const { id } = await params;
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  const db = scoped(ctx);
  const session = await db.sessions.findDetailById(id);
  if (!session) notFound();

  const t = await getTranslations("Sessions");
  const tStatus = await getTranslations("Sessions.status");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  const [enrollments, totals] = await Promise.all([
    db.enrollments.listForClass(session.classGroupId),
    sessionReceiptTotals(prisma, ctx.center.id, session.id),
  ]);

  const activeEnrollments = enrollments.filter((e) => e.status === "ACTIVE");
  const attendeeByStudentId = new Map(
    session.attendees
      .filter((a) => a.studentProfileId)
      .map((a) => [a.studentProfileId as string, a]),
  );

  const rosterMap = new Map<string, RosterRowData>();

  const toRow = (
    studentProfileId: string,
    profile: { firstName: string | null; lastName: string | null; studentCode: string; user: { firstName: string; lastName: string } },
  ): RosterRowData => {
    const attendee = attendeeByStudentId.get(studentProfileId);
    const activePayment = attendee?.payments.find((p) => !p.voided) ?? null;
    return {
      studentProfileId,
      attendeeId: attendee?.id ?? null,
      name: fullName(localName(profile, profile.user)),
      studentCode: profile.studentCode,
      isDropIn: attendee?.isDropIn ?? false,
      status: attendee?.attendanceStatus ?? null,
      payment: activePayment
        ? { id: activePayment.id, amount: activePayment.amount, method: activePayment.method }
        : null,
      consecutiveAbsences: 0,
    };
  };

  for (const enrollment of activeEnrollments) {
    rosterMap.set(
      enrollment.studentProfileId,
      toRow(enrollment.studentProfileId, enrollment.studentProfile),
    );
  }
  for (const attendee of session.attendees) {
    if (!attendee.studentProfileId || rosterMap.has(attendee.studentProfileId)) continue;
    rosterMap.set(attendee.studentProfileId, toRow(attendee.studentProfileId, attendee.studentProfile!));
  }

  const roster = [...rosterMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  await Promise.all(
    roster
      .filter((row) => row.status === "ABSENT")
      .map(async (row) => {
        row.consecutiveAbsences = await consecutiveAbsenceCount(
          prisma,
          ctx.center.id,
          session.classGroupId,
          row.studentProfileId,
          session.date,
        );
      }),
  );

  const rosterStudentIds = new Set(roster.map((row) => row.studentProfileId));
  const candidates: AttendeeCandidate[] =
    query.length > 0
      ? (
          await db.students.search({
            where: {
              ...studentSearchWhere(query),
              active: true,
              ...(rosterStudentIds.size > 0
                ? { NOT: { id: { in: [...rosterStudentIds] } } }
                : {}),
            },
            take: MAX_CANDIDATES,
          })
        ).map((profile) => ({
          studentProfileId: profile.id,
          name: fullName(localName(profile, profile.user)),
          studentCode: profile.studentCode,
        }))
      : [];

  const displayStatus = deriveSessionDisplayStatus(session, new Date());
  const teacherName = fullName(session.teacher);
  const className = sessionDisplayName({ classGroup: session.classGroup });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={className}
        description={t("detailSubtitle", {
          teacher: teacherName,
          date: formatDate(session.date, locale),
        })}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_BADGE[displayStatus]}>{tStatus(displayStatus)}</Badge>
            <Link
              href={ROUTES.centerSessions}
              className="inline-flex h-11 items-center rounded-lg border border-border px-4 text-sm text-text-secondary hover:bg-surface-subtle"
            >
              {t("backToList")}
            </Link>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <Card>
          <CardHeader>
            <CardTitle>{t("roster.title")}</CardTitle>
            <CardDescription>{t("roster.description")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <SessionRoster
              sessionId={session.id}
              rows={roster}
              canCorrect={ctxCan(ctx, "attendance.correct")}
              canRecordPayment={ctxCan(ctx, "payment.record")}
              canVoid={ctxCan(ctx, "payment.void")}
            />

            <div className="border-t border-border pt-4">
              <p className="mb-2 text-sm font-medium text-text-primary">
                {t("addAttendee.title")}
              </p>
              <SearchBox
                value={query}
                label={t("addAttendee.searchLabel")}
                placeholder={t("addAttendee.searchPlaceholder")}
                submitLabel={t("addAttendee.searchSubmit")}
              />
              <div className="mt-4">
                <AddAttendeePanel
                  sessionId={session.id}
                  candidates={candidates}
                  hasQuery={query.length > 0}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("context.title")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.time")}</span>
                <span className="font-medium tabular-nums text-text-primary" dir="ltr">
                  {session.startTime}–{session.endTime}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.room")}</span>
                <span className="font-medium text-text-primary">
                  {session.room?.name ?? tCommon("none")}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-text-secondary">{t("fields.price")}</span>
                <span className="font-medium tabular-nums text-text-primary">
                  {formatMoney(session.priceSnapshot, locale)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("receipt.title")}</CardTitle>
              <CardDescription>{t("receipt.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <SessionReceipt
                totals={totals}
                showProfit={ctxCan(ctx, "center.profit.view")}
                locale={locale}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
