import { CalendarPlus, SearchX } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { AddStudentDialog } from "@/app/[locale]/(center)/students/add-student-dialog";
import { searchStudentsForReceptionAction } from "@/app/[locale]/(center)/reception/actions";
import { CheckInForm } from "@/app/[locale]/(center)/reception/checkin-form";
import { RECEPTION_SEARCH_INPUT_ID } from "@/app/[locale]/(center)/reception/constants";
import { ReceiptDialog } from "@/app/[locale]/(center)/reception/receipt-dialog";
import {
  RecentCheckIns,
  type RecentCheckInRow,
} from "@/app/[locale]/(center)/reception/recent-check-ins";
import { SessionBanner } from "@/app/[locale]/(center)/reception/session-banner";
import { SessionCards } from "@/app/[locale]/(center)/reception/session-cards";
import { SessionCheckIn } from "@/app/[locale]/(center)/reception/session-check-in";
import { loadSessionReceiptView } from "@/app/[locale]/(center)/sessions/[id]/receipt-data";
import { SessionReceipt } from "@/app/[locale]/(center)/sessions/[id]/session-receipt";
import { TypeAheadSearch } from "@/components/center/type-ahead-search";
import { EmptyState } from "@/components/shared/empty-state";
import { Ltr } from "@/components/shared/ltr";
import { FormMessage } from "@/components/shared/form-message";
import { LinkButton } from "@/components/shared/link-button";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db/client";
import {
  loadReceptionSessions,
  openSessionsForStudent,
  recentCheckIns,
  validateReceptionSession,
} from "@/lib/db/reception";
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { signedUrlFor } from "@/lib/db/storage";
import { formatMoney, formatNumber, formatTimeRange } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { centerIdsMatch, parseScannedStudentInput } from "@/lib/id-card";
import { Link, redirect } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { DEFAULT_TIMEZONE } from "@/lib/scheduling";
import { AVATARS_BUCKET } from "@/lib/storage-paths";
import { storageConfigured } from "@/lib/storage";

/**
 * Reception Desk (spec §4.1 item 8, reworked in R7): **Find a student** is a
 * full-width block at the top — search by code/name/phone or scan an ID-card
 * QR — and **Today's sessions** sit below it as cards, never beside it.
 *
 * Two modes, one input:
 * - *Plain*: the search box is a GET form (the scan is its own submit, parsed
 *   by `lib/id-card.ts`'s `parseScannedStudentInput`); a found student gets
 *   the check-in form, offering only today's sessions that are still open,
 *   each labelled "name · teacher · time".
 * - *Session mode* (`?session=<id>`): staff pick one of today's sessions
 *   first and every scan or typed student goes to a confirm panel for that
 *   session. The id in the URL is untrusted — it is re-validated here on every
 *   request (`validateReceptionSession`) and an invalid one leaves session
 *   mode with a notice.
 *
 * Finding a session outside today is the "add-session shortcut" — a link to
 * the full Sessions dashboard. (R4: a class's sessions exist for its whole
 * period; changing them is a Manager/Owner class edit, not something Reception
 * runs.) Ending a session reuses R2's `EndSessionButton` →
 * `endSessionAction`, and the receipt is R2's `SessionReceipt`.
 */
export default async function ReceptionPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    studentId?: string;
    session?: string;
    receipt?: string;
    notice?: string;
  }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "reception.use");

  const { q, studentId, session: sessionParam, receipt: receiptParam, notice } = await searchParams;
  const query = (q ?? "").trim();

  const db = scoped(ctx);
  const centerId = ctx.center.id;
  const locale = await getLocale();
  const t = await getTranslations("Reception");
  const tCommon = await getTranslations("Settings.common");

  const now = new Date();
  const timeZone = ctx.settings?.timezone ?? DEFAULT_TIMEZONE;
  const permissions = { checkIn: ctxCan(ctx, "attendance.record"), end: ctxCan(ctx, "session.close") };

  const [cards, grades, paymentMethods] = await Promise.all([
    loadReceptionSessions(prisma, { centerId, locale, timeZone, now, permissions }),
    db.grades.list(),
    // R1: the centre's own active methods — a deactivated one never reaches
    // the picker (the action re-checks "this centre, active" regardless).
    db.paymentMethods.listActive(),
  ]);

  // Session mode: the id in the URL is untrusted input, re-validated on every
  // request — same centre, today in the centre's timezone, not cancelled,
  // rescheduled or closed, and the signed-in role may check students in.
  let attending: (typeof cards)[number] | null = null;
  if (sessionParam) {
    const check = await validateReceptionSession(prisma, {
      centerId,
      sessionId: sessionParam,
      timeZone,
      now,
    });
    attending = check.ok ? (cards.find((card) => card.id === sessionParam && card.canAttend) ?? null) : null;
    if (!attending) {
      // Silently out of session mode, with a notice (and the receipt, if one was asked for).
      redirect({
        href: `${ROUTES.centerReception}?notice=sessionUnavailable${
          receiptParam ? `&receipt=${encodeURIComponent(receiptParam)}` : ""
        }`,
        locale,
      });
    }
  }
  const attendingId = attending?.id ?? null;

  // ── Plain mode: resolve what was scanned or typed ──────────────────────────
  let selectedStudent:
    | { id: string; name: string; code: string; photoUrl: string | null }
    | null = null;
  let scanProblem: "otherBranch" | "unreadable" | "notFound" | "inactive" | null = null;
  let results: { studentProfileId: string; name: string; studentCode: string }[] = [];

  const parsed = !attending && query.length > 0 ? parseScannedStudentInput(query) : null;
  if (!attending) {
    type FoundStudent = NonNullable<Awaited<ReturnType<typeof db.students.findByCode>>>;
    let found: FoundStudent | null = null;

    const runSearch = async (text: string) =>
      (
        await db.students.search({
          where: { ...studentSearchWhere(text), active: true },
          take: 8,
        })
      ).map((profile) => ({
        studentProfileId: profile.id,
        name: fullName(localName(profile, profile.user)),
        studentCode: profile.studentCode,
      }));

    if (parsed?.kind === "payload") {
      // A card issued by another centre is refused on its centre id alone.
      if (centerIdsMatch(parsed.centerId, centerId)) {
        found = await db.students.findByCode(parsed.studentCode);
        if (!found) scanProblem = "notFound";
      } else {
        scanProblem = "otherBranch";
      }
    } else if (parsed?.kind === "code") {
      found = await db.students.findByCode(parsed.studentCode);
      if (!found) results = await runSearch(query);
    } else if (parsed?.kind === "unreadable") {
      scanProblem = "unreadable";
    } else if (parsed?.kind === "text") {
      results = await runSearch(parsed.text);
    }

    if (found && !found.active) {
      scanProblem = "inactive";
      found = null;
    }

    if (found) {
      selectedStudent = {
        id: found.id,
        name: fullName(localName(found, found.user)),
        code: found.studentCode,
        photoUrl: found.photoUrl,
      };
    } else if (studentId && !scanProblem) {
      const student = await db.students.findDetailById(studentId);
      if (student) {
        selectedStudent = {
          id: student.id,
          name: fullName(localName(student, student.user)),
          code: student.studentCode,
          photoUrl: student.photoUrl,
        };
      }
    }
  }

  // The anti-impersonation control the static QR decision rests on (spec
  // §5.1 "Check-in & the QR payload", closing §7.1's second verified gap): a
  // human comparing the face on screen to the person in front of them. A
  // short-lived signed URL, not a data URI — this is a live render, not a
  // stored artifact that must outlive the request (unlike the ID card SVG).
  const sign = (path: string | null) =>
    path && storageConfigured() ? signedUrlFor(centerId, AVATARS_BUCKET, path) : Promise.resolve(null);

  const selectedStudentPhotoUrl = selectedStudent ? await sign(selectedStudent.photoUrl) : null;

  const studentSessions = selectedStudent
    ? await openSessionsForStudent(prisma, {
        centerId,
        studentProfileId: selectedStudent.id,
        cards,
      })
    : null;

  // Session mode: the last few check-ins on the selected session.
  const recent = attending ? await recentCheckIns(prisma, { centerId, sessionId: attending.id }) : [];
  const recentRows: RecentCheckInRow[] = await Promise.all(
    recent.map(async (row) => ({
      id: row.id,
      studentName: row.studentName,
      studentCode: row.studentCode,
      photoUrl: await sign(row.photoPath),
      status: row.status,
      recordedAt: row.recordedAt,
    })),
  );

  // A closed session's receipt in the shared dialog — only for a card on
  // today's list that is closed (the URL is untrusted here too).
  const receiptCard = receiptParam
    ? cards.find((card) => card.id === receiptParam && card.canViewReceipt)
    : undefined;
  const receiptSession = receiptCard ? await db.sessions.findById(receiptCard.id) : null;
  const receiptView =
    receiptCard && receiptSession ? await loadSessionReceiptView(centerId, receiptSession) : null;

  const gradeOptions = grades
    .filter((grade) => grade.catalogActive)
    .map((grade) => ({
      value: grade.id,
      label: grade.active ? grade.name : `${grade.name} · ${tCommon("inactive")}`,
    }));


  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        compactOnPhone
        action={
          // The desk's primary is the search, so Register student is outline here.
          <div className="flex flex-wrap items-center gap-2">
            <AddStudentDialog grades={gradeOptions} noneLabel={tCommon("none")} variant="outline" />
            <LinkButton href={ROUTES.centerSessions}>
              <CalendarPlus className="size-4" aria-hidden />
              {t("addSessionShortcut")}
            </LinkButton>
          </div>
        }
      />

      {notice === "sessionUnavailable" ? (
        <FormMessage tone="info">{t("sessionMode.sessionUnavailable")}</FormMessage>
      ) : null}

      {attending ? (
        <SessionBanner
          label={attending.label}
          detail={[
            attending.teacherName,
            formatTimeRange(attending.startTime, attending.endTime, locale),
            attending.rooms.join(" + "),
          ]
            .filter(Boolean)
            .join(" · ")}
          live={attending.displayStatus === "LIVE"}
          checkedIn={formatNumber(attending.checkedIn, locale)}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("searchTitle")}</CardTitle>
          <CardDescription>
            {attending ? t("sessionMode.searchDescription") : t("searchDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {attending ? (
            // From xl the confirm area and the running list sit side by side,
            // so a wide monitor does not put the status 1,400px from the name.
            <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
              <SessionCheckIn
                sessionId={attending.id}
                priceLabel={attending.price > 0 ? formatMoney(attending.price, locale) : null}
                paymentMethods={paymentMethods.map(({ id, name }) => ({ id, name }))}
              />
              <RecentCheckIns
                sessionId={attending.id}
                rows={recentRows}
                total={attending.checkedIn}
                locale={locale}
                timeZone={timeZone}
                className="xl:border-t-0 xl:border-s xl:ps-4 xl:pt-0"
              />
            </div>
          ) : (
            <div className="flex max-w-3xl flex-col gap-4">
              <TypeAheadSearch
                size="lg"
                hideLabel
                inputId={RECEPTION_SEARCH_INPUT_ID}
                autoFocus
                // A scanned payload (a long UUID) is shown as the student's code, not as raw text.
                value={selectedStudent && parsed?.kind === "payload" ? selectedStudent.code : query}
                label={t("searchLabel")}
                placeholder={t("searchPlaceholder")}
                submitLabel={t("searchSubmit")}
                search={searchStudentsForReceptionAction}
              />

              {scanProblem ? (
                <FormMessage tone={scanProblem === "otherBranch" ? "error" : "warning"}>
                  {t(`scan.${scanProblem}`)}
                </FormMessage>
              ) : null}

              {query.length > 0 && !selectedStudent && !scanProblem ? (
                results.length === 0 ? (
                  <EmptyState compact icon={<SearchX />} tone="warning" title={t("noMatches")} description={t("noMatchesHint")} />
                ) : (
                  <ul className="flex flex-col gap-2">
                    {results.map((result) => (
                      <li key={result.studentProfileId}>
                        <Link
                          href={`${ROUTES.centerReception}?studentId=${result.studentProfileId}`}
                          className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border p-3 transition-ui focus-ring hover:border-border-strong hover:bg-surface-hover active:bg-surface-active"
                        >
                          <span className="truncate text-sm font-medium text-text-primary">
                            {result.name}
                          </span>
                          <span className="shrink-0 text-xs text-text-secondary">
                            <Ltr>{result.studentCode}</Ltr>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}

              {selectedStudent && studentSessions ? (
                <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
                  <CheckInForm
                    studentProfileId={selectedStudent.id}
                    studentName={selectedStudent.name}
                    studentCode={selectedStudent.code}
                    studentPhotoUrl={selectedStudentPhotoUrl}
                    sessions={studentSessions.options.map((card) => ({
                      sessionId: card.id,
                      label: card.label,
                      teacherName: card.teacherName,
                      startTime: card.startTime,
                    }))}
                    preselectSessionId={studentSessions.preselectId}
                    paymentMethods={paymentMethods.map(({ id, name }) => ({ id, name }))}
                  />
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card id="today-sessions" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>{t("liveRailTitle")}</CardTitle>
          <CardDescription>{t("liveRailDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <SessionCards
            attendingId={attendingId}
            cards={cards.map((card) => ({
              id: card.id,
              label: card.label,
              teacherName: card.teacherName,
              startTime: card.startTime,
              endTime: card.endTime,
              rooms: card.rooms,
              displayStatus: card.displayStatus,
              autoClosed: card.autoClosed,
              checkedIn: card.checkedIn,
              canAttend: card.canAttend,
              end: card.end,
              canViewReceipt: card.canViewReceipt,
            }))}
          />
        </CardContent>
      </Card>

      {receiptCard && receiptView ? (
        <ReceiptDialog
          title={t("receipt.title", { session: receiptCard.label })}
          description={[receiptCard.teacherName, formatTimeRange(receiptCard.startTime, receiptCard.endTime, locale)]
            .filter(Boolean)
            .join(" · ")}
          closeHref={attendingId ? `${ROUTES.centerReception}?session=${attendingId}` : ROUTES.centerReception}
          printHref={ROUTES.centerSessionPrint(receiptCard.id)}
          closeLabel={t("receipt.close")}
          printLabel={t("receipt.print")}
          newTabLabel={t("receipt.opensInNewTab")}
        >
          <SessionReceipt
            totals={receiptView.totals}
            showProfit={ctxCan(ctx, "center.profit.view")}
            locale={locale}
            timeZone={timeZone}
            closure={receiptView.closure}
            changes={receiptView.changes}
            voids={receiptView.voids}
            refunds={receiptView.refunds}
            unpaid={receiptView.unpaid}
          />
        </ReceiptDialog>
      ) : null}
    </div>
  );
}
