import { getLocale, getTranslations } from "next-intl/server";
import { SearchX } from "lucide-react";

import { DiscoverFilters } from "@/app/[locale]/(student)/student/discover/discover-filters";
import { ReserveButton } from "@/app/[locale]/(student)/student/discover/reserve-button";
import { Pagination } from "@/components/center/pagination";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { requireStudentUser } from "@/lib/auth/tenant";
import { listCatalogGrades, listCatalogSubjects } from "@/lib/db/catalog";
import { prisma } from "@/lib/db/client";
import {
  discoverClassesForCenter,
  teacherDisplayNames,
  type DiscoverClassRow,
} from "@/lib/db/discover";
import { teacherRatingAverages } from "@/lib/db/ratings";
import {
  studentActiveEnrollmentClassIds,
  studentBlockedRefsByCenter,
  studentReservationStatusByClass,
} from "@/lib/db/student-portal";
import { formatMoney, formatRating, formatTimeRange } from "@/lib/format";
import { nameInitial } from "@/lib/initials";
import { enrollmentCap, isAtCapacity } from "@/lib/capacity";
import { classRoomSetFrom } from "@/lib/db/room-sets";
import { subjectAccentColor } from "@/lib/subject-accent";
import { catalogLabel, catalogLabelWithSelection } from "@/lib/catalog";
import { mapWithConcurrency } from "@/lib/concurrency";
import { ROUTES } from "@/lib/routes";
import { centerLogoSrc } from "@/lib/storage-paths";
import { DEFAULT_PAGE_SIZE, parsePageParam } from "@/lib/validation/people";
import { EmptyState } from "@/components/shared/empty-state";
import { listAccessibleCenters } from "@/lib/db/platform";
import { ResultsRegion } from "@/components/shared/results-region";

type CardStatus = "enrolled" | "pending" | "full" | "open" | "requiresApproval";

type CardViewModel = {
  centerId: string;
  centerName: string;
  centerLogoUrl: string | null;
  classGroupId: string;
  subjectName: string | null;
  gradeName: string | null;
  teacherName: string;
  /** Average out of 5, platform-wide, across every centre this teacher works
   * at (M17) — never a count alongside it (spec §5 "Teacher ratings"). */
  teacherRating: number | null;
  roomName: string | null;
  price: number;
  requiresConfirmation: boolean;
  schedules: DiscoverClassRow["schedules"];
  status: CardStatus;
};

const STATUS_BADGE: Record<CardStatus, "success" | "warning" | "neutral" | "info"> = {
  enrolled: "success",
  pending: "warning",
  full: "neutral",
  open: "info",
  requiresApproval: "warning",
};

/** Centres whose classes load in parallel on one Discover page load (SEC-32). */
const DISCOVER_CENTER_CONCURRENCY = 5;

export default async function StudentDiscoverPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireStudentUser();
  const rawParams = await searchParams;
  const subjectFilter = rawParams.subject?.trim() || "";
  const gradeFilter = rawParams.grade?.trim() || "";
  const dayFilter = rawParams.day?.trim() || "";

  const t = await getTranslations("StudentDiscover");
  const tClasses = await getTranslations("Classes");
  const locale = await getLocale();
  const dayNames = tClasses.raw("dayNames") as string[];

  const [centers, blockedByCenter, reservationByClass, enrolledClassIds, allSubjects, allGrades] =
    await Promise.all([
      listAccessibleCenters(prisma),
      studentBlockedRefsByCenter(prisma, session.user.id),
      studentReservationStatusByClass(prisma, session.user.id),
      studentActiveEnrollmentClassIds(prisma, session.user.id),
      // The full global catalog (M13) — filter options come from here, not
      // from whatever happens to be in the current result set, so every
      // pill stays available even while a filter narrows the cards shown.
      listCatalogSubjects(prisma),
      listCatalogGrades(prisma),
    ]);

  // Global catalog ids (M13) mean the same thing at every centre, so the
  // subject/grade filter is a real scoped `where` per centre now — never the
  // pre-M13 in-memory name match (docs/02-architecture.md §14).
  // SEC-32: at most DISCOVER_CENTER_CONCURRENCY centres in flight at once — a
  // page load never holds one pool connection per centre on the platform.
  const perCenter = await mapWithConcurrency(
    centers,
    DISCOVER_CENTER_CONCURRENCY,
    async (center) => {
      const classes = await discoverClassesForCenter(prisma, center.id, {
        subjectId: subjectFilter || undefined,
        gradeId: gradeFilter || undefined,
      });
      const teacherIds = [...new Set(classes.map((row) => row.teacherId))];
      const teacherNames = await teacherDisplayNames(prisma, center.id, teacherIds);
      return { center, classes, teacherNames };
    },
  );

  // Ratings are platform-wide by teacherId, never per-centre (M17, spec §5
  // "Teacher ratings" — "follows the teacher across centres") — one batched
  // lookup across every centre's classes combined, not one per centre.
  const allTeacherIds = [...new Set(perCenter.flatMap(({ classes }) => classes.map((row) => row.teacherId)))];
  const teacherRatings = await teacherRatingAverages(prisma, allTeacherIds);

  const blockedEverywhere = blockedByCenter;
  const cards: CardViewModel[] = [];

  for (const { center, classes, teacherNames } of perCenter) {
    const blocked = blockedEverywhere.get(center.id);
    for (const row of classes) {
      if (blocked?.teacherIds.has(row.teacherId)) continue;
      if (blocked?.classGroupIds.has(row.id)) continue;

      const isEnrolled = enrolledClassIds.has(row.id);
      const reservationStatus = reservationByClass.get(row.id);
      const isFull =
        !isEnrolled &&
        !row.requiresConfirmation &&
        isAtCapacity(row._count.enrollments, enrollmentCap(classRoomSetFrom(row).capacity));

      let status: CardStatus;
      if (isEnrolled) status = "enrolled";
      else if (reservationStatus === "PENDING") status = "pending";
      else if (isFull) status = "full";
      else status = row.requiresConfirmation ? "requiresApproval" : "open";

      cards.push({
        centerId: center.id,
        centerName: center.name,
        centerLogoUrl: centerLogoSrc(center),
        classGroupId: row.id,
        subjectName: catalogLabelWithSelection(locale, row.subject),
        gradeName: catalogLabelWithSelection(locale, row.grade),
        teacherName: teacherNames.get(row.teacherId) ?? "—",
        teacherRating: teacherRatings.get(row.teacherId) ?? null,
        roomName: classRoomSetFrom(row).rooms.map((room) => room.name).join(" + ") || null,
        price: row.price,
        requiresConfirmation: row.requiresConfirmation,
        schedules: row.schedules,
        status,
      });
    }
  }

  const subjectOptions = allSubjects
    .map((subject) => ({ value: subject.id, label: catalogLabel(locale, subject) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const gradeOptions = allGrades
    .map((grade) => ({ value: grade.id, label: catalogLabel(locale, grade) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Subject/grade are already applied in each centre's own query above; only
  // the day filter (a child-row check) still happens here, in memory, after
  // the per-centre results are combined.
  const filtered = cards.filter((card) => {
    if (dayFilter) {
      const day = Number(dayFilter);
      if (!card.schedules.some((slot) => slot.dayOfWeek === day)) return false;
    }
    return true;
  });

  const page = parsePageParam(rawParams.page);
  const pageSize = DEFAULT_PAGE_SIZE;
  const total = filtered.length;
  const pageEntries = filtered.slice((page - 1) * pageSize, page * pageSize);

  const buildHref = (targetPage: number) => {
    const params = new URLSearchParams();
    if (subjectFilter) params.set("subject", subjectFilter);
    if (gradeFilter) params.set("grade", gradeFilter);
    if (dayFilter) params.set("day", dayFilter);
    if (targetPage > 1) params.set("page", String(targetPage));
    const qs = params.toString();
    return qs ? `${ROUTES.studentDiscover}?${qs}` : ROUTES.studentDiscover;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("subtitle", { count: total })} />

      <DiscoverFilters
        subject={subjectFilter}
        grade={gradeFilter}
        day={dayFilter}
        subjects={subjectOptions}
        grades={gradeOptions}
        dayNames={dayNames}
        allLabel={t("filters.all")}
      />

      <ResultsRegion className="flex flex-col gap-6">
        {pageEntries.length === 0 ? (
          <EmptyState icon={<SearchX />} tone="warning" title={t("empty")} description={t("emptyHint")} />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {pageEntries.map((card) => (
              <div
                key={`${card.centerId}:${card.classGroupId}`}
                className="relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border bg-surface p-4 pt-5 shadow-card transition-ui hover:border-border-strong hover:shadow-card-hover"
              >
                <div
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-1"
                  style={{ backgroundColor: subjectAccentColor(card.subjectName) }}
                />

                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">
                      {card.subjectName ?? tClasses("columns.untitled")}
                    </p>
                    <p className="truncate text-xs text-text-muted">{card.centerName}</p>
                  </div>
                  <Badge variant={STATUS_BADGE[card.status]}>{t(`status.${card.status}`)}</Badge>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ backgroundColor: subjectAccentColor(card.subjectName) }}
                  >
                    {nameInitial(card.teacherName)}
                  </span>
                  <span className="min-w-0 truncate text-sm text-text-secondary">{card.teacherName}</span>
                  {card.teacherRating !== null ? (
                    <span className="ms-auto shrink-0 text-xs font-medium text-text-muted">
                      {t("card.rating", { value: formatRating(card.teacherRating, locale) })}
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  {card.gradeName ? (
                    <span className="rounded-full border border-border px-2 py-0.5">{card.gradeName}</span>
                  ) : null}
                  {card.schedules.length > 0 ? (
                    <span>
                      {card.schedules
                        .map(
                          (slot) =>
                            `${dayNames[slot.dayOfWeek]} ${formatTimeRange(slot.startTime, slot.endTime, locale)}`,
                        )
                        .join(" · ")}
                    </span>
                  ) : (
                    <span>{t("card.noSchedule")}</span>
                  )}
                </div>

                <p className="text-sm font-semibold text-text-primary">{formatMoney(card.price, locale)}</p>

                <div className="mt-auto">
                  {card.status === "enrolled" || card.status === "pending" ? (
                    <Badge
                      variant={card.status === "enrolled" ? "success" : "warning"}
                      className="w-full justify-center py-2"
                    >
                      {t(`card.${card.status}`)}
                    </Badge>
                  ) : card.status === "full" ? (
                    <Badge variant="neutral" className="w-full justify-center py-2">
                      {t("card.full")}
                    </Badge>
                  ) : (
                    <ReserveButton
                      centerId={card.centerId}
                      classGroupId={card.classGroupId}
                      requiresConfirmation={card.requiresConfirmation}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <Pagination page={page} pageSize={pageSize} total={total} buildHref={buildHref} />
      </ResultsRegion>
    </div>
  );
}
