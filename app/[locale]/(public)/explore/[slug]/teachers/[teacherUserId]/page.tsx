import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { ClassCard, ClassCardGrid } from "@/components/explore/class-card";
import { EnrolAction, seatBadge } from "@/components/explore/enrol-action";
import { PageHeader } from "@/components/shared/page-header";
import { PersonAvatar } from "@/components/shared/person-avatar";
import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/auth/session";
import { branchName } from "@/lib/branch-name";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { publicBranchBySlug, publicTeacherAt, publicTeacherPhotoUrl } from "@/lib/db/public-catalog";
import { formatRating } from "@/lib/format";
import { ROUTES } from "@/lib/routes";

type Params = { params: Promise<{ slug: string; teacherUserId: string }> };

/** Once per request — the metadata and the page share it. */
const load = cache(async (slug: string, teacherUserId: string) => {
  const branch = await publicBranchBySlug(prisma, decodeURIComponent(slug));
  if (!branch) return null;
  const teacher = await publicTeacherAt(prisma, branch, decodeURIComponent(teacherUserId), new Date());
  if (!teacher) return null;
  return { branch, teacher, photoUrl: await publicTeacherPhotoUrl(prisma, branch, teacher.teacherUserId) };
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, teacherUserId } = await params;
  const found = await load(slug, teacherUserId);
  if (!found) return {};
  return { title: `${found.teacher.name} · ${branchName(await getLocale(), found.branch)}` };
}

/**
 * A teacher at one listed branch (F5). Per branch because a teacher's name is
 * that branch's own record (CLAUDE.md rule 4); the rating is the platform-wide
 * average (spec §5 "Teacher ratings"), shown as `4.6 ★` with no count, and
 * omitted when there is none. A teacher with no listed class here is a 404.
 */
export default async function ExploreTeacherPage({ params }: Params) {
  const { slug, teacherUserId } = await params;
  const found = await load(slug, teacherUserId);
  if (!found) notFound();
  const { branch, teacher, photoUrl } = found;

  const locale = await getLocale();
  const t = await getTranslations("Explore");
  const user = await getCurrentUser();
  const name = branchName(locale, branch);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={teacher.name}
        description={t("teacher.subtitle", { branch: name })}
        back={{ href: ROUTES.exploreBranch(branch.slug), label: t("backToBranch", { branch: name }) }}
        leading={<PersonAvatar name={teacher.name} photoUrl={photoUrl} size="md" tone="brand" />}
        meta={
          teacher.rating !== null ? (
            <Badge variant="neutral">{t("card.rating", { value: formatRating(teacher.rating, locale) })}</Badge>
          ) : undefined
        }
      />

      <section aria-labelledby="teacher-classes" className="flex flex-col gap-4">
        <h2 id="teacher-classes" className="text-lg font-semibold text-text-primary">
          {t("teacher.classesTitle")}
        </h2>
        <ClassCardGrid>
          {await Promise.all(
            teacher.classes.map(async (item) => {
              const href = ROUTES.exploreClass(branch.slug, item.id);
              return (
                <ClassCard
                  key={item.id}
                  href={href}
                  subjectName={catalogLabelWithSelection(locale, item.subject)}
                  branchName={name}
                  pausedUntil={branch.pausedUntil}
                  teacherName={item.teacherName}
                  imageUrl={item.imageUrl}
                  teacherRating={item.teacherRating}
                  gradeName={catalogLabelWithSelection(locale, item.grade)}
                  schedules={item.schedules}
                  price={item.price}
                  badge={await seatBadge(item.seats)}
                  action={
                    <EnrolAction
                      signedIn={Boolean(user)}
                      centerId={branch.id}
                      classId={item.id}
                      requiresConfirmation={item.requiresConfirmation}
                      seats={item.seats}
                      returnPath={href}
                      item={item}
                      branchLabel={name}
                    />
                  }
                />
              );
            }),
          )}
        </ClassCardGrid>
      </section>
    </div>
  );
}
