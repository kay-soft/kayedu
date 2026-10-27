import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { DiscoverAction } from "@/app/[locale]/(student)/student/discover/discover-action";
import { DISCOVER_STATUS_BADGE, discoverCardStatus } from "@/app/[locale]/(student)/student/discover/card-status";
import { ClassDetail } from "@/components/explore/class-detail";
import { PageHeader } from "@/components/shared/page-header";
import { requireStudentUser } from "@/lib/auth/tenant";
import { branchName } from "@/lib/branch-name";
import { enrollmentCap, isAtCapacity } from "@/lib/capacity";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { discoverCenter, discoverClassById, teacherDisplayNames } from "@/lib/db/discover";
import { teacherRatingAverage } from "@/lib/db/ratings";
import { classRoomSetFrom } from "@/lib/db/room-sets";
import {
  studentActiveEnrollmentClassIds,
  studentBlockedRefsByCenter,
  studentReservationStatusByClass,
} from "@/lib/db/student-portal";
import { centerLogoSrc } from "@/lib/storage-paths";
import { ROUTES } from "@/lib/routes";

/**
 * A Discover class for the signed-in student (F5): the same class page
 * component as Explore (`ClassDetail`), under Discover's own rules — any
 * accessible branch (not only publicly listed ones), active and accepting new
 * students, hidden when a block applies, with this student's own status.
 */
export default async function StudentDiscoverClassPage({
  params,
}: {
  params: Promise<{ centerId: string; classId: string }>;
}) {
  const session = await requireStudentUser();
  const { centerId, classId } = await params;

  const center = await discoverCenter(prisma, centerId);
  if (!center) notFound();
  const row = await discoverClassById(prisma, center.id, classId);
  if (!row) notFound();

  const [blockedByCenter, reservationByClass, enrolledClassIds, names, rating] = await Promise.all([
    studentBlockedRefsByCenter(prisma, session.user.id),
    studentReservationStatusByClass(prisma, session.user.id),
    studentActiveEnrollmentClassIds(prisma, session.user.id),
    teacherDisplayNames(prisma, center.id, [row.teacherId]),
    teacherRatingAverage(prisma, row.teacherId),
  ]);

  const blocked = blockedByCenter.get(center.id);
  if (blocked?.teacherIds.has(row.teacherId) || blocked?.classGroupIds.has(row.id)) notFound();

  const locale = await getLocale();
  const t = await getTranslations("StudentDiscover");
  const tExplore = await getTranslations("Explore");

  const isEnrolled = enrolledClassIds.has(row.id);
  const status = discoverCardStatus({
    isEnrolled,
    reservationStatus: reservationByClass.get(row.id),
    isFull: !isEnrolled && isAtCapacity(row._count.enrollments, enrollmentCap(classRoomSetFrom(row).capacity)),
    requiresConfirmation: row.requiresConfirmation,
  });
  const name = branchName(locale, center);
  const subject = catalogLabelWithSelection(locale, row.subject) ?? tExplore("class.untitled");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={subject}
        description={name}
        back={{ href: ROUTES.studentDiscover, label: tExplore("backToDiscover") }}
      />

      <ClassDetail
        gradeName={catalogLabelWithSelection(locale, row.grade)}
        branch={{ name, logoUrl: centerLogoSrc(center), themeColor: center.themeColor }}
        teacher={{ name: names.get(row.teacherId) ?? "—", rating: rating.average }}
        schedules={row.schedules}
        startDate={row.startDate}
        endDate={row.endDate}
        price={row.price}
        requiresConfirmation={row.requiresConfirmation}
        badge={{ variant: DISCOVER_STATUS_BADGE[status], label: t(`status.${status}`) }}
        action={
          <DiscoverAction
            status={status}
            centerId={center.id}
            classGroupId={row.id}
            requiresConfirmation={row.requiresConfirmation}
            labels={{ enrolled: t("card.enrolled"), pending: t("card.pending"), full: t("card.full") }}
          />
        }
      />
    </div>
  );
}
