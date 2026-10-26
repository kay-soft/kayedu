import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";

import {
  RatingPopup,
  type PendingRatingSessionView,
} from "@/app/[locale]/(student)/rating-popup";
import { ProfileCompletionForm } from "@/app/[locale]/(student)/student/profile/profile-completion-form";
import { shellScope, shellUser, type ShellFrame } from "@/components/shell/from-context";
import { navForExperience } from "@/components/shell/nav";
import { requireStudentUser, studentBrand } from "@/lib/auth/tenant";
import { catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import { centerGrades } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { teacherDisplayNames } from "@/lib/db/discover";
import { attendedSessionsToRate } from "@/lib/db/ratings";
import { formatDate } from "@/lib/format";
import { localName } from "@/lib/identity";
import { SIDEBAR_COLLAPSED_COOKIE } from "@/lib/ui/sidebar-cookie";
import { centerNamesByIds } from "@/lib/db/platform";
import { catalogSubjectsWithSelections } from "@/lib/db/catalog";

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
    centerNamesByIds(prisma, centerIds),
    subjectIds.length > 0
      ? // Each centre's own rename travels with the subject (R8): a row is
        // labelled with the selections of *its* centre only.
        catalogSubjectsWithSelections(prisma, subjectIds, centerIds)
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
 * The student portal's shell (F2: shared by `(student)/layout.tsx` and
 * Account settings). Role gate: any signed-in `User` — not
 * `requireExperience("student")`. A brand-new sign-up has zero relations
 * anywhere until they discover and reserve/enroll in their first class, so
 * this gate cannot require a `StudentProfile` up front (see
 * `requireStudentUser`'s doc comment, `lib/auth/tenant.ts`).
 *
 * `interruptions` (default on) is the M18 completion gate and the M17 rating
 * pop-up. Account settings (F2) turns them off: changing a password is not
 * part of the student portal, and must not wait on finishing a profile.
 */
export async function studentShell({ interruptions = true }: { interruptions?: boolean } = {}): Promise<ShellFrame> {
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

  if (interruptions && incomplete?.studentProfile) {
    const profile = incomplete.studentProfile;
    // SEC-49: the grades this branch offers (its own catalog selection, under
    // its own display name) — the action accepts nothing else.
    const grades = await centerGrades(prisma, incomplete.center.id);
    const tCommon = await getTranslations("Settings.common");
    const gradeOptions = grades
      .filter((grade) => (grade.active && grade.catalogActive) || grade.id === profile.gradeId)
      .map((grade) => ({
        value: grade.id,
        label: catalogLabel(locale, grade, grade),
      }));

    return {
      props: {
        experience: "student",
        nav: navForExperience("student", "STUDENT"),
        brand: studentBrand(session),
        user: shellUser(session.user, "STUDENT"),
        defaultCollapsed,
      },
      replace: (
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
      ),
    };
  }

  const pendingRatings = interruptions ? await pendingRatingViews(session.user.id, locale) : [];

  return {
    props: {
      experience: "student",
      nav: navForExperience("student", "STUDENT"),
      brand: studentBrand(session),
      user: shellUser(session.user, "STUDENT"),
      scope: shellScope(session.relations, [], session.studentRelation?.center.id ?? null),
      defaultCollapsed,
    },
    lead: interruptions ? <RatingPopup sessions={pendingRatings} /> : null,
  };
}
