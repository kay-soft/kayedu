import { notFound } from "next/navigation";
import { GraduationCap, Phone } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import {
  BlockList,
  type BlockCandidate,
  type BlockedStudent,
} from "@/app/[locale]/(center)/teachers/[id]/block-list";
import { TeacherProfileForm } from "@/app/[locale]/(center)/teachers/[id]/teacher-profile-form";
import {
  deleteTeacherAction,
  searchBlockCandidatesAction,
} from "@/app/[locale]/(center)/teachers/actions";
import { DeleteRecordCard } from "@/components/center/delete-record-card";
import { TypeAheadSearch } from "@/components/center/type-ahead-search";
import { DetailCard, DetailLayout } from "@/components/shared/detail-layout";
import { EmptyState } from "@/components/shared/empty-state";
import { DetailRow } from "@/components/shared/field";
import { PageHeader } from "@/components/shared/page-header";
import { PersonAvatar } from "@/components/shared/person-avatar";
import { Badge } from "@/components/ui/badge";
import { PickBranchScreen } from "@/components/shell/pick-branch-screen";
import { requireBranchScope } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { prisma } from "@/lib/db/client";
import { teacherRatingAverage } from "@/lib/db/ratings";
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { formatRating } from "@/lib/format";
import { fullName, localName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";
import { ResultsRegion } from "@/components/shared/results-region";

const MAX_BLOCK_CANDIDATES = 8;

/**
 * One teacher at this center (spec §4.1 item 2): their record, the classes they
 * carry, and their student block-list.
 *
 * R10b layout (docs/04 §5 "Detail page"): a header with the teacher's first
 * letter, phone and active state; a main column of the record (including the
 * trusted-teacher setting) and the classes they teach; a side column of the
 * rating (average only) and the block list; the danger zone set apart at the
 * foot.
 *
 * The id in the URL is a **membership** id and is resolved through the scoped
 * helper, so a teacher id from another center resolves to "not found" rather
 * than to a row (docs/02 §5).
 */
export default async function TeacherDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return <PickBranchScreen ctx={ctx} />;
  await requirePermission(ctx, "teacher.manage");

  const { id } = await params;
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  const db = scoped(ctx);
  const teacher = await db.teachers.findById(id);
  if (!teacher) notFound();

  const t = await getTranslations("Teachers");
  const tCommon = await getTranslations("Settings.common");
  const locale = await getLocale();

  // Security fix 16 (M12, docs/00-master-product-spec.md §5 "Teacher detail
  // leak"): this page must never reveal which other centres this teacher
  // works at, so nothing here queries across centres — everything below is
  // scoped to this center alone.
  const [classes, blocks, rating] = await Promise.all([
    db.classGroups.list({ teacherId: teacher.userId }),
    db.studentBlocks.list({ scope: "TEACHER", refId: teacher.userId }),
    // M17, spec §5 "Teacher ratings": platform-wide by the teacher's global
    // id, average-only — the same shape the teacher's own dashboard and
    // Discover cards read, never a centre-privileged view of the count.
    teacherRatingAverage(prisma, teacher.userId),
  ]);

  // A block stores the student's *User* id; the name shown is this center's
  // student record for that person, never another center's.
  const blockedUserIds = blocks.map((block) => block.blockedUserId);
  const blockedProfiles =
    blockedUserIds.length > 0
      ? await db.students.list({ userId: { in: blockedUserIds } })
      : [];
  const profileByUserId = new Map(
    blockedProfiles.map((profile) => [profile.userId, profile]),
  );

  const blocked: BlockedStudent[] = blocks.map((block) => {
    const profile = profileByUserId.get(block.blockedUserId);
    return {
      blockId: block.id,
      studentProfileId: profile?.id ?? null,
      name: profile
        ? fullName(localName(profile, profile.user))
        : t("blocks.unknownStudent"),
      studentCode: profile?.studentCode ?? null,
      reason: block.reason,
    };
  });

  const candidates: BlockCandidate[] =
    query.length > 0
      ? (
          await db.students.search({
            where: {
              ...studentSearchWhere(query),
              active: true,
              ...(blockedUserIds.length > 0
                ? { NOT: { userId: { in: blockedUserIds } } }
                : {}),
            },
            take: MAX_BLOCK_CANDIDATES,
          })
        ).map((profile) => ({
          studentProfileId: profile.id,
          name: fullName(localName(profile, profile.user)),
          studentCode: profile.studentCode,
        }))
      : [];

  const personName = fullName(localName(teacher, teacher.user));
  const canBlock = ctxCan(ctx, "student.block");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={personName}
        description={t("detailSubtitle")}
        back={{ href: ROUTES.centerTeachers, label: t("backToList") }}
        leading={<PersonAvatar name={personName} />}
        meta={
          <>
            <Badge variant={teacher.active ? "success" : "neutral"}>
              {teacher.active ? tCommon("active") : tCommon("inactive")}
            </Badge>
            {teacher.phone ? (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="size-4 text-text-muted" aria-hidden />
                <span dir="ltr">{teacher.phone}</span>
              </span>
            ) : null}
          </>
        }
      />

      <DetailLayout
        main={
          <>
            <DetailCard title={t("profileTitle")} description={t("profileDescription")}>
              <TeacherProfileForm
                membershipId={teacher.id}
                name={localName(teacher, teacher.user)}
                contact={{
                  email: teacher.email ?? "",
                  phone: teacher.phone ?? "",
                  altPhone: teacher.altPhone ?? "",
                }}
                isTrustedTeacher={teacher.isTrustedTeacher}
              />
            </DetailCard>

            <DetailCard title={t("classesTitle")} description={t("classesDescription")}>
              {classes.length === 0 ? (
                <EmptyState
                  compact
                  icon={<GraduationCap />}
                  title={t("classesEmpty")}
                  description={t("classesEmptyHint")}
                />
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {classes.map((classGroup) => (
                    <li
                      key={classGroup.id}
                      className="flex flex-col gap-1 rounded-xl border border-border p-3"
                    >
                      <Link
                        href={ROUTES.centerClass(classGroup.id)}
                        className="text-sm font-medium text-brand hover:underline"
                      >
                        {classGroup.subject ? catalogLabelWithSelection(locale, classGroup.subject) : tCommon("none")}
                      </Link>
                      <span className="text-xs text-text-muted">
                        {[classGroup.grade ? catalogLabelWithSelection(locale, classGroup.grade) : null, classGroup.room?.name]
                          .filter(Boolean)
                          .join(" · ") || tCommon("none")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </DetailCard>
          </>
        }
        side={
          <>
            <DetailCard
              title={t("identityTitle")}
              description={t("identityDescription")}
              contentClassName="gap-0"
            >
              <DetailRow
                label={t("fields.accountClaimed")}
                // A yes/no fact, not an active/inactive state — "Inactive" (in
                // Arabic, "suspended") read as if the teacher were barred.
                value={teacher.user.authId ? t("fields.accountClaimedYes") : t("fields.accountClaimedNo")}
              />
              <DetailRow
                label={t("rating.title")}
                value={rating.average !== null ? formatRating(rating.average, locale) : t("rating.none")}
              />
            </DetailCard>

            <DetailCard title={t("blocks.title")} description={t("blocks.description")}>
              {canBlock ? (
                <TypeAheadSearch
                  value={query}
                  label={t("blocks.searchLabel")}
                  placeholder={t("blocks.searchPlaceholder")}
                  submitLabel={t("blocks.searchSubmit")}
                  search={searchBlockCandidatesAction.bind(null, teacher.id)}
                />
              ) : null}

              <ResultsRegion>
                <BlockList
                  teacherUserId={teacher.userId}
                  blocked={blocked}
                  candidates={canBlock ? candidates : []}
                  query={canBlock ? query : ""}
                />
              </ResultsRegion>
            </DetailCard>
          </>
        }
        below={
          ctxCan(ctx, "teacher.delete") ? (
            <DeleteRecordCard
              action={deleteTeacherAction}
              idField="membershipId"
              recordId={teacher.id}
              title={t("danger.title")}
              description={t("danger.description")}
              confirmMessage={t("deleteConfirm")}
            />
          ) : null
        }
      />
    </div>
  );
}
