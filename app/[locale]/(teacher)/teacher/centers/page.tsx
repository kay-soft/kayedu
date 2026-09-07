import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { TeachAtCenterCard } from "@/app/[locale]/(teacher)/teacher/centers/teach-at-center-card";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireTeacherUser } from "@/lib/auth/tenant";
import { listCatalogGrades, listCatalogSubjects } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { ACCESSIBLE_LIFECYCLE_STATES } from "@/lib/db/platform";
import { catalogLabel } from "@/lib/catalog";
import { ROUTES } from "@/lib/routes";

/**
 * The centre directory (M15, spec §4.2 item 7 / §5.1 "Teacher onboarding"):
 * a teacher with **zero** centres browses active centres and requests to
 * teach a class at one, pending that centre's approval — the teacher-side
 * counterpart to Discover's self-serve first connection for students. Goes
 * through the existing `ChangeRequest`/`/approvals` machinery
 * (`requestToTeachAction`), never a parallel workflow.
 */
export default async function TeacherCentersPage() {
  const session = await requireTeacherUser();
  // A teacher who already teaches somewhere has their own dashboard/classes
  // screens for finding more work; this screen exists specifically to get a
  // zero-centre teacher unstuck.
  if (session.hasCenter) redirect(ROUTES.teacherDashboard);

  const t = await getTranslations("TeacherCenters");
  const locale = await getLocale();

  const [centers, subjects, grades] = await Promise.all([
    prisma.center.findMany({
      where: { lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } },
      select: { id: true, name: true, logoUrl: true, themeColor: true },
      orderBy: { name: "asc" },
    }),
    listCatalogSubjects(prisma),
    listCatalogGrades(prisma),
  ]);

  const subjectOptions = subjects
    .map((subject) => ({ value: subject.id, label: catalogLabel(locale, subject) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const gradeOptions = grades
    .map((grade) => ({ value: grade.id, label: catalogLabel(locale, grade) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      {centers.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-text-muted">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {centers.map((center) => (
            <TeachAtCenterCard
              key={center.id}
              center={center}
              subjects={subjectOptions}
              grades={gradeOptions}
            />
          ))}
        </div>
      )}
    </div>
  );
}
