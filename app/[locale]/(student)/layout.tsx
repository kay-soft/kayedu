import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { getLocale } from "next-intl/server";

import {
  RatingPopup,
  type PendingRatingSessionView,
} from "@/app/[locale]/(student)/rating-popup";
import { AppShell } from "@/components/shell/app-shell";
import { shellUser } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { requireStudentUser, studentBrand } from "@/lib/auth/tenant";
import { catalogLabel } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { teacherDisplayNames } from "@/lib/db/discover";
import { attendedSessionsToRate } from "@/lib/db/ratings";
import { formatDate } from "@/lib/format";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";

/**
 * The M17 login pop-up's read side: sessions this student attended in the
 * last 7 days, not yet rated or skipped (`attendedSessionsToRate`, itself
 * identity-scoped across every centre — never one `centerId`). Resolved into
 * display strings here, the same "compose display names in the page/layout,
 * not in lib/db" shape the Discover page already uses for teacher names
 * (`lib/db/discover.ts`'s `teacherDisplayNames`).
 */
async function pendingRatingViews(
  studentUserId: string,
  locale: string,
): Promise<PendingRatingSessionView[]> {
  const now = new Date();
  const pending = await attendedSessionsToRate(prisma, studentUserId, now);
  if (pending.length === 0) return [];

  const centerIds = [...new Set(pending.map((row) => row.centerId))];
  const subjectIds = [...new Set(pending.map((row) => row.subjectId).filter((id): id is string => id !== null))];

  const [centers, subjects, teacherNamesByCenter] = await Promise.all([
    prisma.center.findMany({ where: { id: { in: centerIds } }, select: { id: true, name: true } }),
    subjectIds.length > 0
      ? prisma.catalogSubject.findMany({ where: { id: { in: subjectIds } } })
      : Promise.resolve([]),
    Promise.all(
      centerIds.map(async (centerId) => {
        const teacherIds = [
          ...new Set(pending.filter((row) => row.centerId === centerId).map((row) => row.teacherId)),
        ];
        return [centerId, await teacherDisplayNames(prisma, centerId, teacherIds)] as const;
      }),
    ).then((entries) => new Map(entries)),
  ]);

  const centerNameById = new Map(centers.map((center) => [center.id, center.name]));
  const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));

  return pending.map((row) => ({
    sessionId: row.sessionId,
    date: formatDate(row.date, locale),
    centerName: centerNameById.get(row.centerId) ?? "",
    teacherName: teacherNamesByCenter.get(row.centerId)?.get(row.teacherId) ?? "—",
    subjectName: row.subjectId ? catalogLabel(locale, subjectById.get(row.subjectId)!) : null,
  }));
}

/**
 * Role gate: any signed-in `User` — not `requireExperience("student")`. A
 * brand-new sign-up has zero relations anywhere until they discover and
 * reserve/enroll in their first class, so this gate cannot require a
 * `StudentProfile` up front (see `requireStudentUser`'s doc comment,
 * `lib/auth/tenant.ts`).
 */
export default async function StudentLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireStudentUser();
  const defaultCollapsed = await cookies().then(
    (store) => store.get(SIDEBAR_COLLAPSED_COOKIE)?.value === "1",
  );
  const locale = await getLocale();
  const pendingRatings = await pendingRatingViews(session.user.id, locale);

  return (
    <AppShell
      nav={navForExperience("student", "STUDENT")}
      brand={studentBrand(session)}
      user={shellUser(session.user, "STUDENT")}
      canSwitchCenter={session.relations.length > 1}
      defaultCollapsed={defaultCollapsed}
    >
      <RatingPopup sessions={pendingRatings} />
      {children}
    </AppShell>
  );
}
