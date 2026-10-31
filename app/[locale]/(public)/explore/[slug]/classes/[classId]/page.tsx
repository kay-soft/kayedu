import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { ClassDetail } from "@/components/explore/class-detail";
import { EnrolAction, seatBadge } from "@/components/explore/enrol-action";
import { SessionBookingLink } from "@/components/explore/session-booking-link";
import { PageHeader } from "@/components/shared/page-header";
import { getCurrentUser } from "@/lib/auth/session";
import { branchName } from "@/lib/branch-name";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { publicBranchBySlug, publicClassById } from "@/lib/db/public-catalog";
import { ROUTES } from "@/lib/routes";

type Params = {
  params: Promise<{ slug: string; classId: string }>;
  searchParams: Promise<{ join?: string }>;
};

/** Once per request — the metadata and the page share it. */
const load = cache(async (slug: string, classId: string) => {
  const branch = await publicBranchBySlug(prisma, decodeURIComponent(slug));
  if (!branch) return null;
  const item = await publicClassById(prisma, branch, decodeURIComponent(classId), new Date());
  return item ? { branch, item } : null;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, classId } = await params;
  const found = await load(slug, classId);
  if (!found) return {};
  const locale = await getLocale();
  const t = await getTranslations("Explore.class");
  const subject = catalogLabelWithSelection(locale, found.item.subject) ?? t("untitled");
  return { title: `${subject} · ${branchName(locale, found.branch)}` };
}

/**
 * A listed class at a listed branch (F5). Enrol asks a guest to sign in and
 * brings them back here (`?next=`); someone signed in goes straight through
 * the existing `reserveOrEnroll` path. An unlisted branch, or an inactive,
 * ended or closed class, is a 404.
 */
export default async function ExploreClassPage({ params, searchParams }: Params) {
  const { slug, classId } = await params;
  // U8 — a guest's Enrol intent came back through sign-in: reopen the confirmation.
  const { join } = await searchParams;
  const found = await load(slug, classId);
  if (!found) notFound();
  const { branch, item } = found;

  const locale = await getLocale();
  const t = await getTranslations("Explore");
  const user = await getCurrentUser();
  const name = branchName(locale, branch);
  const subject = catalogLabelWithSelection(locale, item.subject) ?? t("class.untitled");
  const here = ROUTES.exploreClass(branch.slug, item.id);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={subject}
        description={name}
        back={{ href: ROUTES.exploreBranch(branch.slug), label: t("backToBranch", { branch: name }) }}
      />

      <ClassDetail
        gradeName={catalogLabelWithSelection(locale, item.grade)}
        branch={{
          name,
          href: ROUTES.exploreBranch(branch.slug),
          logoUrl: branch.logoUrl,
          themeColor: branch.themeColor,
          pausedUntil: branch.pausedUntil,
        }}
        teacher={{
          name: item.teacherName,
          href: ROUTES.exploreTeacher(branch.slug, item.teacherUserId),
          rating: item.teacherRating,
        }}
        schedules={item.schedules}
        startDate={item.startDate}
        endDate={item.endDate}
        price={item.price}
        requiresConfirmation={item.requiresConfirmation}
        badge={await seatBadge(item.seats)}
        action={
          <EnrolAction
            signedIn={Boolean(user)}
            centerId={branch.id}
            classId={item.id}
            requiresConfirmation={item.requiresConfirmation}
            seats={item.seats}
            returnPath={here}
            item={item}
            branchLabel={name}
            openJoin={join === "1"}
          />
        }
      />

      <SessionBookingLink
        mode={item.sessionBookingMode}
        signedIn={Boolean(user)}
        centerId={branch.id}
        classId={item.id}
      />
    </div>
  );
}
