import type { Metadata } from "next";
import { BookOpen } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import {
  removeOwnClassCoverAction,
  removeOwnTeacherPhotoAction,
  updateOwnClassCoverAction,
  updateOwnTeacherPhotoAction,
} from "@/app/[locale]/(teacher)/teacher/profile/actions";
import { ClassCard, ClassCardGrid } from "@/components/explore/class-card";
import { EmptyState } from "@/components/shared/empty-state";
import { ImageUploadForm } from "@/components/shared/image-upload-form";
import { PageHeader } from "@/components/shared/page-header";
import { PageSection } from "@/components/shared/page-section";
import { PersonAvatar } from "@/components/shared/person-avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { getTeacherScope } from "@/lib/auth/teacher-scope";
import { catalogLabelWithSelection } from "@/lib/catalog";
import { scoped } from "@/lib/db/scoped";
import { fullName, localName } from "@/lib/identity";
import { mediaUploadsEnabled } from "@/lib/media";
import { MAX_COVER_BYTES, MAX_PHOTO_BYTES, classImageSrc, teacherPhotoSrc } from "@/lib/storage-paths";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("TeacherProfile");
  return { title: t("title") };
}

/**
 * The teacher's own picture and their classes' covers (U9). The photo is
 * **per branch** — a teacher can look different at each — with "Use this photo
 * at all my branches" to copy one upload to every branch they teach at; each
 * branch can still replace or remove it. A class cover is optional, and the
 * class's own teacher may set it. Both are shown here exactly as a student will
 * see them on the class card: cover, else this photo, else the generated look.
 *
 * One scoped read per branch in view, listed together (U7) — never a `where`
 * across branches. Owning the row is the authority (see `./actions.ts`).
 */
export default async function TeacherProfilePage() {
  const scope = await getTeacherScope();
  const t = await getTranslations("TeacherProfile");
  const locale = await getLocale();
  const enabled = mediaUploadsEnabled();
  const severalBranches = scope.contexts.length > 1;

  const perBranch = await Promise.all(
    scope.inView.map(async (ctx) => {
      const db = scoped(ctx);
      const [membership, classes] = await Promise.all([
        db.teachers.findByUserId(ctx.user.id),
        db.classGroups.list({ teacherId: ctx.user.id, active: true }),
      ]);
      const withSchedules = await Promise.all(
        classes.map(async (classGroup) => ({ classGroup, schedules: await db.classSchedules.list(classGroup.id) })),
      );
      return { ctx, membership, classes: withSchedules };
    }),
  );

  const classCount = perBranch.reduce((sum, entry) => sum + entry.classes.length, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />

      <PageSection title={t("photoTitle")} description={t("photoDescription")}>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {perBranch.map(({ ctx, membership }) => {
            if (!membership) return null;
            const name = fullName(localName(membership, membership.user));
            const photoSrc = teacherPhotoSrc(ctx.center.id, ctx.user.id, membership.photoKey);
            return (
              <Card key={ctx.center.id}>
                <CardHeader>
                  <CardTitle as="h3">{ctx.center.name}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <PersonAvatar name={name} photoUrl={photoSrc} />
                    <p className="min-w-0 break-words text-sm font-medium text-text-primary">{name}</p>
                  </div>
                  <ImageUploadForm
                    kind="teacherPhoto"
                    enabled={enabled}
                    hasImage={Boolean(membership.photoKey)}
                    uploadAction={updateOwnTeacherPhotoAction}
                    removeAction={removeOwnTeacherPhotoAction}
                    fields={{ centerId: ctx.center.id }}
                    fieldName="photo"
                    maxBytes={MAX_PHOTO_BYTES}
                    maxEdge={1024}
                  >
                    {severalBranches ? (
                      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover">
                        <Checkbox name="allBranches" className="mt-0.5" />
                        <span className="flex min-w-0 flex-col">
                          <span className="text-sm font-medium text-text-primary">{t("allBranches")}</span>
                          <span className="text-xs text-text-muted">{t("allBranchesHint")}</span>
                        </span>
                      </label>
                    ) : null}
                  </ImageUploadForm>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </PageSection>

      <PageSection title={t("classesTitle")} description={t("classesDescription")}>
        {classCount === 0 ? (
          <EmptyState icon={<BookOpen />} title={t("classesEmpty")} description={t("classesEmptyHint")} />
        ) : (
          <ClassCardGrid>
            {perBranch.flatMap(({ ctx, membership, classes }) =>
              classes.map(({ classGroup, schedules }) => (
                <ClassCard
                  key={`${ctx.center.id}:${classGroup.id}`}
                  subjectName={catalogLabelWithSelection(locale, classGroup.subject)}
                  branchName={ctx.center.name}
                  teacherName={membership ? fullName(localName(membership, membership.user)) : ""}
                  imageUrl={classImageSrc(ctx.center.id, classGroup.id, {
                    coverKey: classGroup.coverKey,
                    teacherPhotoKey: membership?.photoKey,
                  })}
                  teacherRating={null}
                  gradeName={catalogLabelWithSelection(locale, classGroup.grade)}
                  schedules={schedules}
                  price={classGroup.price}
                  badge={{ variant: "success", label: t("classActive") }}
                  action={
                    <ImageUploadForm
                      kind="classCover"
                      enabled={enabled}
                      hasImage={Boolean(classGroup.coverKey)}
                      uploadAction={updateOwnClassCoverAction}
                      removeAction={removeOwnClassCoverAction}
                      fields={{ centerId: ctx.center.id, classGroupId: classGroup.id }}
                      fieldName="cover"
                      maxBytes={MAX_COVER_BYTES}
                      maxEdge={1280}
                    />
                  }
                />
              )),
            )}
          </ClassCardGrid>
        )}
      </PageSection>
    </div>
  );
}
