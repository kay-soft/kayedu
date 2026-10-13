import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";

import {
  RatingPopup,
  type PendingRatingSessionView,
} from "@/app/[locale]/(student)/rating-popup";
import { ProfileCompletionForm } from "@/app/[locale]/(student)/student/profile/profile-completion-form";
import { AppShell } from "@/components/shell/app-shell";
import { shellScope, shellUser } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { requireStudentUser, studentBrand } from "@/lib/auth/tenant";
import { CATALOG_OVERRIDE_SELECT, catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import { listCatalogGrades } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { teacherDisplayNames } from "@/lib/db/discover";
import { attendedSessionsToRate } from "@/lib/db/ratings";
import { formatDate } from "@/lib/format";
import { localName } from "@/lib/identity";
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
      ? // Each centre's own rename travels with the subject (R8): a row is
        // labelled with the selections of *its* centre only.
        prisma.catalogSubject.findMany({
          where: { id: { in: subjectIds } },
          include: {
            selections: {
              where: { centerId: { in: centerIds } },
              select: { centerId: true, ...CATALOG_OVERRIDE_SELECT },
            },
          },
        })
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
  const subjectForCenter = (subjectId: string, centerId: string) => {
    const subject = subjectById.get(subjectId);
    return subject
      ? { ...subject, selections: subject.selections.filter((selection) => selection.centerId === centerId) }
      : null;
  };

  return pending.map((row) => ({
    sessionId: row.sessionId,
    date: formatDate(row.date, locale),
    centerName: centerNameById.get(row.centerId) ?? "",
    teacherName: teacherNamesByCenter.get(row.centerId)?.get(row.teacherId) ?? "—",
    // R5: a one-time session leads with its own title.
    subjectName:
      [
        row.title,
        row.subjectId
          ? catalogLabelWithSelection(locale, subjectForCenter(row.subjectId, row.centerId))
          : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
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

  // M18 (spec §4.3 item 4): a self-registered student's `StudentProfile` is
  // an auto-seeded stub (name/email/phone/altPhone only, from
  // `ensureStudentProfile`) until they complete it themselves — never a
  // permanent stub. Every /student/* request goes through this layout, so
  // gating here (by substituting the form for `children`, not redirecting)
  // covers the whole route group with no pathname check needed, and a
  // receptionist-added student (whose profile is already whole,
  // `profileCompletedAt` stamped at creation) never sees it at all.
  const incomplete = session.relations.find(
    (relation) => relation.studentProfile && !relation.studentProfile.profileCompletedAt,
  );

  if (incomplete?.studentProfile) {
    const profile = incomplete.studentProfile;
    const grades = await listCatalogGrades(prisma);
    const tCommon = await getTranslations("Settings.common");
    const gradeOptions = grades.map((grade) => ({
      value: grade.id,
      label: catalogLabel(locale, grade),
    }));

    return (
      <AppShell
        nav={navForExperience("student", "STUDENT")}
        brand={studentBrand(session)}
        user={shellUser(session.user, "STUDENT")}
        defaultCollapsed={defaultCollapsed}
      >
        <ProfileCompletionForm
          centerId={incomplete.center.id}
          studentProfileId={profile.id}
          centerName={incomplete.center.name}
          name={localName(profile, session.user)}
          contact={{
            email: profile.email ?? "",
            phone: profile.phone ?? "",
            altPhone: profile.altPhone ?? "",
          }}
          student={{
            gradeId: profile.gradeId ?? "",
            parentFirstName: profile.parentFirstName ?? "",
            parentLastName: profile.parentLastName ?? "",
            parentPhone: profile.parentPhone ?? "",
            parentAltPhone: profile.parentAltPhone ?? "",
          }}
          grades={gradeOptions}
          noneLabel={tCommon("none")}
        />
      </AppShell>
    );
  }

  const pendingRatings = await pendingRatingViews(session.user.id, locale);

  return (
    <AppShell
      nav={navForExperience("student", "STUDENT")}
      brand={studentBrand(session)}
      user={shellUser(session.user, "STUDENT")}
      scope={shellScope(session.relations, [], session.studentRelation?.center.id ?? null)}
      defaultCollapsed={defaultCollapsed}
    >
      <RatingPopup sessions={pendingRatings} />
      {children}
    </AppShell>
  );
}
