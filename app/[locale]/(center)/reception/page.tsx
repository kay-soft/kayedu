import { CalendarPlus } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { AddStudentDialog } from "@/app/[locale]/(center)/students/add-student-dialog";
import { CheckInForm } from "@/app/[locale]/(center)/reception/checkin-form";
import {
  LiveSessionRail,
  type LiveSessionOption,
} from "@/app/[locale]/(center)/reception/live-session-rail";
import { SearchBox } from "@/components/center/search-box";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { scoped } from "@/lib/db/scoped";
import { deriveSessionDisplayStatus, sessionDisplayName } from "@/lib/db/sessions";
import { studentSearchWhere } from "@/lib/db/students";
import { fullName, localName } from "@/lib/identity";
import { parseStudentQrPayload } from "@/lib/id-card";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { startOfUtcDay } from "@/lib/scheduling";

/**
 * Reception Desk (spec §4.1 item 8): search by code/name/phone — or a
 * scanned ID-card QR — today's sessions marked live, and one check-in flow
 * that records attendance and (for PRESENT/LATE) payment together. A USB QR
 * scanner types like a keyboard and submits on Enter, so no camera/client
 * code is needed: the search box's own GET submit is the "scan" (`lib/id-
 * card.ts`'s `parseStudentQrPayload`, spec §2 "Check-in methods"). Finding a
 * session outside today, or before it has been generated, is the
 * "add-session shortcut" — a link to the full Today's Sessions dashboard,
 * which stays a Manager/Owner-only action (`session.manage`) for actually
 * running the generator (spec §4.1 item 3), since Reception is where
 * RECEPTIONIST — who does not hold that permission — spends the day.
 */
export default async function ReceptionPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; studentId?: string }>;
}) {
  const ctx = await getTenantContext("center");
  await requirePermission(ctx, "reception.use");

  const { q, studentId } = await searchParams;
  const query = (q ?? "").trim();

  const db = scoped(ctx);
  const t = await getTranslations("Reception");
  const tCommon = await getTranslations("Settings.common");

  const today = startOfUtcDay(new Date());
  const now = new Date();

  const [todaySessions, grades] = await Promise.all([
    db.sessions.listForDay(today),
    db.grades.list(),
  ]);

  // Batch teacher names once, matching the pattern on /classes and /sessions.
  const teacherIds = [...new Set(todaySessions.map((row) => row.teacherId))];
  const teachers =
    teacherIds.length > 0 ? await db.teachers.list({ userId: { in: teacherIds } }) : [];
  const teacherNameByUserId = new Map(
    teachers.map((teacher) => [teacher.userId, fullName(localName(teacher, teacher.user))]),
  );

  const liveSessions: LiveSessionOption[] = todaySessions.map((row) => ({
    sessionId: row.id,
    className: sessionDisplayName(row),
    teacherName: teacherNameByUserId.get(row.teacherId) ?? tCommon("none"),
    startTime: row.startTime,
    endTime: row.endTime,
    displayStatus: deriveSessionDisplayStatus(row, now),
  }));

  // A scanned QR resolves directly by exact student code — never the fuzzy
  // multi-token search — and only if it was issued by *this* center.
  const qrPayload = query.length > 0 ? parseStudentQrPayload(query) : null;
  const qrStudent =
    qrPayload && qrPayload.centerId === ctx.center.id
      ? await db.students.findByCode(qrPayload.studentCode)
      : null;

  const results =
    query.length > 0 && !qrPayload
      ? (
          await db.students.search({
            where: { ...studentSearchWhere(query), active: true },
            take: 8,
          })
        ).map((profile) => ({
          studentProfileId: profile.id,
          name: fullName(localName(profile, profile.user)),
          studentCode: profile.studentCode,
        }))
      : [];

  let selectedStudent: { id: string; name: string; code: string } | null = null;
  if (qrStudent) {
    selectedStudent = {
      id: qrStudent.id,
      name: fullName(localName(qrStudent, qrStudent.user)),
      code: qrStudent.studentCode,
    };
  } else if (studentId) {
    const student = await db.students.findDetailById(studentId);
    if (student) {
      selectedStudent = {
        id: student.id,
        name: fullName(localName(student, student.user)),
        code: student.studentCode,
      };
    }
  }

  const gradeOptions = grades.map((grade) => ({
    value: grade.id,
    label: grade.active ? grade.name : `${grade.name} · ${tCommon("inactive")}`,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <AddStudentDialog grades={gradeOptions} noneLabel={tCommon("none")} />
            <Link
              href={ROUTES.centerSessions}
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-border px-4 text-sm font-medium text-text-secondary hover:bg-surface-subtle"
            >
              <CalendarPlus className="size-4" aria-hidden />
              {t("addSessionShortcut")}
            </Link>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <Card>
          <CardHeader>
            <CardTitle>{t("searchTitle")}</CardTitle>
            <CardDescription>{t("searchDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <SearchBox
              value={query}
              label={t("searchLabel")}
              placeholder={t("searchPlaceholder")}
              submitLabel={t("searchSubmit")}
            />

            {query.length > 0 && !selectedStudent ? (
              results.length === 0 ? (
                <p className="text-sm text-text-muted">{t("noMatches")}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {results.map((result) => (
                    <li key={result.studentProfileId}>
                      <Link
                        href={`${ROUTES.centerReception}?studentId=${result.studentProfileId}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 hover:bg-surface-subtle"
                      >
                        <span className="truncate text-sm font-medium text-text-primary">
                          {result.name}
                        </span>
                        <span className="shrink-0 text-xs text-text-muted" dir="ltr">
                          {result.studentCode}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )
            ) : null}

            {selectedStudent ? (
              <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
                <CheckInForm
                  studentProfileId={selectedStudent.id}
                  studentName={selectedStudent.name}
                  sessions={liveSessions}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("liveRailTitle")}</CardTitle>
            <CardDescription>{t("liveRailDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <LiveSessionRail sessions={liveSessions} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
