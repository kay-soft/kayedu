import { redirect } from "next/navigation";
import { BriefcaseBusiness, Building2 } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { TeachAtCenterCard } from "@/app/[locale]/(teacher)/teacher/centers/teach-at-center-card";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { LinkButton } from "@/components/shared/link-button";
import { isPremium } from "@/lib/auth/premium";
import { requireTeacherUser } from "@/lib/auth/tenant";
import { listCatalogEducationSystems, listCatalogGrades, listCatalogSubjects } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import { catalogLabel } from "@/lib/catalog";
import { buildCatalogPicker } from "@/lib/catalog-picker";
import { ROUTES } from "@/lib/routes";
import { centerLogoSrc } from "@/lib/storage-paths";
import { EmptyState } from "@/components/shared/empty-state";
import { listAccessibleCenters } from "@/lib/db/platform";

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

  const [centers, systems, subjects, grades] = await Promise.all([
    listAccessibleCenters(prisma),
    listCatalogEducationSystems(prisma),
    listCatalogSubjects(prisma),
    listCatalogGrades(prisma),
  ]);

  // The active global catalog (no branch's picks — this teacher belongs to
  // none), system → grade → subject with each subject under its linked
  // grades (U3). The action re-checks the pair against the catalog.
  const byLabel = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const pick = <T extends { nameAr: string; nameEn: string }>(row: T) => ({
    ...row,
    name: catalogLabel(locale, row),
    active: true,
    catalogActive: true,
  });
  const catalog = buildCatalogPicker(
    {
      systems: systems.map(pick).sort(byLabel),
      grades: grades.map(pick).sort(byLabel),
      subjects: subjects.map(pick).sort(byLabel),
    },
    (name) => name,
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      {/* W8a (D-W38): a premium account with no branch can run its own
          workspace instead — the only way in from here, since this shell's
          nav stays the directory alone (M15). */}
      {isPremium(session.user) ? (
        <Card>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-text-secondary">{t("workspacesHint")}</p>
            <LinkButton href={ROUTES.teacherWorkspaces} className="w-full sm:w-fit">
              <BriefcaseBusiness className="size-4" aria-hidden />
              {t("workspacesLink")}
            </LinkButton>
          </CardContent>
        </Card>
      ) : null}

      {centers.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={<Building2 />} title={t("empty")} description={t("emptyHint")} />
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {centers.map((center) => (
            <TeachAtCenterCard
              key={center.id}
              center={{
                id: center.id,
                name: center.name,
                themeColor: center.themeColor,
                logoUrl: centerLogoSrc(center),
              }}
              catalog={catalog}
            />
          ))}
        </div>
      )}
    </div>
  );
}
