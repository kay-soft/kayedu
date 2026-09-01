import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  BlockList,
  type BlockCandidate,
  type BlockedStudent,
} from "@/app/[locale]/(center)/teachers/[id]/block-list";
import { TeacherProfileForm } from "@/app/[locale]/(center)/teachers/[id]/teacher-profile-form";
import { SearchBox } from "@/components/center/search-box";
import { DetailRow } from "@/components/shared/field";
import { FormMessage } from "@/components/shared/form-message";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ctxCan, getTenantContext, requirePermission } from "@/lib/auth/tenant";
import { countOtherCenterRelations } from "@/lib/db/identity";
import { scoped } from "@/lib/db/scoped";
import { studentSearchWhere } from "@/lib/db/students";
import { canEditGlobalProfile, fullName } from "@/lib/identity";
import { Link } from "@/lib/i18n/navigation";
import { ROUTES } from "@/lib/routes";

const MAX_BLOCK_CANDIDATES = 8;

/**
 * One teacher at this center (spec §4.1 item 2): their record, the classes they
 * carry, and their student block-list.
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
  const ctx = await getTenantContext({ experience: "center" });
  await requirePermission(ctx, "teacher.manage");

  const { id } = await params;
  const { q } = await searchParams;
  const query = (q ?? "").trim();

  const db = scoped(ctx);
  const teacher = await db.teachers.findById(id);
  if (!teacher) notFound();

  const t = await getTranslations("Teachers");
  const tCommon = await getTranslations("Settings.common");

  const [classes, blocks, otherRelations] = await Promise.all([
    db.classGroups.list({ teacherId: teacher.userId }),
    db.studentBlocks.list({ scope: "TEACHER", refId: teacher.userId }),
    countOtherCenterRelations(teacher.userId, ctx.center.id),
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
      name: profile ? fullName(profile.user) : t("blocks.unknownStudent"),
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
          name: fullName(profile.user),
          studentCode: profile.studentCode,
        }))
      : [];

  const profileEditable = canEditGlobalProfile({
    authId: teacher.user.authId,
    otherCenterRelations: otherRelations,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={fullName(teacher.user)}
        description={t("detailSubtitle")}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={teacher.active ? "success" : "neutral"}>
              {teacher.active ? tCommon("active") : tCommon("inactive")}
            </Badge>
            <Link
              href={ROUTES.centerTeachers}
              className="inline-flex h-11 items-center rounded-lg border border-border px-4 text-sm text-text-secondary hover:bg-surface-subtle"
            >
              {t("backToList")}
            </Link>
          </div>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <Card>
          <CardHeader>
            <CardTitle>{t("profileTitle")}</CardTitle>
            <CardDescription>{t("profileDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <TeacherProfileForm
              membershipId={teacher.id}
              values={{
                firstName: teacher.user.firstName,
                lastName: teacher.user.lastName,
                email: teacher.user.email ?? "",
                phone: teacher.user.phone ?? "",
                altPhone: teacher.user.altPhone ?? "",
              }}
              canSeeEarnings={teacher.canSeeEarnings}
              profileEditable={profileEditable}
              canDelete={ctxCan(ctx, "teacher.delete")}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{t("identityTitle")}</CardTitle>
              <CardDescription>{t("identityDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <DetailRow
                label={t("fields.otherCenters")}
                value={String(otherRelations)}
              />
              <DetailRow
                label={t("fields.accountClaimed")}
                value={
                  teacher.user.authId ? tCommon("active") : tCommon("inactive")
                }
              />
              <DetailRow
                label={t("canSeeEarnings")}
                value={
                  teacher.canSeeEarnings ? tCommon("active") : tCommon("inactive")
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("classesTitle")}</CardTitle>
              <CardDescription>{t("classesDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              {classes.length === 0 ? (
                <FormMessage tone="info">{t("classesEmpty")}</FormMessage>
              ) : (
                <ul className="flex flex-col gap-2">
                  {classes.map((classGroup) => (
                    <li
                      key={classGroup.id}
                      className="flex flex-col gap-1 rounded-xl border border-border p-3"
                    >
                      <span className="text-sm font-medium text-text-primary">
                        {classGroup.subject?.name ?? tCommon("none")}
                      </span>
                      <span className="text-xs text-text-muted">
                        {[classGroup.grade?.name, classGroup.room?.name]
                          .filter(Boolean)
                          .join(" · ") || tCommon("none")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("blocks.title")}</CardTitle>
          <CardDescription>{t("blocks.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {ctxCan(ctx, "student.block") ? (
            <SearchBox
              value={query}
              label={t("blocks.searchLabel")}
              placeholder={t("blocks.searchPlaceholder")}
              submitLabel={t("blocks.searchSubmit")}
            />
          ) : null}

          <BlockList
            teacherUserId={teacher.userId}
            blocked={blocked}
            candidates={ctxCan(ctx, "student.block") ? candidates : []}
            query={ctxCan(ctx, "student.block") ? query : ""}
          />
        </CardContent>
      </Card>
    </div>
  );
}
