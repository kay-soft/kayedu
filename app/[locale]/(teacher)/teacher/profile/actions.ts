"use server";

import { revalidatePath } from "next/cache";

import { teacherActionScope, teacherBranchContext } from "@/lib/auth/teacher-scope";
import type { TenantContext } from "@/lib/auth/tenant";
import { clearClassCover, clearTeacherPhoto, readTeacherPhoto, setClassCover, setTeacherPhoto } from "@/lib/db/media-writes";
import { scoped } from "@/lib/db/scoped";
import { readRasterImage } from "@/lib/db/storage";
import { mediaUploadsEnabled } from "@/lib/media";
import { ROUTES } from "@/lib/routes";
import { MAX_COVER_BYTES } from "@/lib/storage-paths";
import type { ActionState } from "@/lib/validation/form";
import { ownClassCoverSchema, ownTeacherPhotoSchema } from "@/lib/validation/media";

/**
 * The teacher's own photo and their own classes' covers (U9). No permission
 * from the matrix is involved — the authority is *owning the row*: the photo
 * is this person's TEACHER membership at the branch, the cover is on a class
 * whose `teacherId` is them. Under All branches a write names its branch and
 * that id is never trusted: it is re-resolved through the actor's own
 * relations (`teacherBranchContext`, SEC-44), then every read and write is
 * scoped to that branch, so another branch's or another teacher's row is "not
 * found". A branch can replace or remove what is set here (`teacher.manage`,
 * `class.manage`). Audited with the same actions as the branch's own path,
 * `by: "teacher"`. While `MEDIA_UPLOADS_ENABLED` is off nothing is stored.
 */

const FORBIDDEN: ActionState = { error: "forbidden" };
const NOT_FOUND: ActionState = { error: "notFound" };

function revalidateProfile(locale: string): void {
  revalidatePath(`/${locale}${ROUTES.teacherProfile}`);
}

/** Runs `write` at each branch; the first error wins, but every branch is tried. */
async function eachBranch(
  targets: TenantContext[],
  write: (ctx: TenantContext, membershipId: string) => Promise<{ ok: true } | { ok: false; error: string }>,
): Promise<ActionState> {
  let error: string | null = null;
  for (const ctx of targets) {
    const membership = await scoped(ctx).teachers.findByUserId(ctx.user.id);
    if (!membership) {
      error ??= "notFound";
      continue;
    }
    const result = await write(ctx, membership.id);
    if (!result.ok) error ??= result.error;
  }
  return error ? { error } : { status: "saved" };
}

export async function updateOwnTeacherPhotoAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = ownTeacherPhotoSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { centerId, allBranches, locale } = parsed.data;

  // The named branch, re-resolved through the actor's own relations (SEC-44) —
  // or, for "all my branches", every branch they hold an active TEACHER role at.
  const targets = allBranches
    ? ((await teacherActionScope())?.contexts ?? [])
    : [await teacherBranchContext(centerId)].filter((ctx): ctx is TenantContext => ctx !== null);
  if (targets.length === 0) return FORBIDDEN;

  if (!mediaUploadsEnabled()) return { error: "mediaNotConnected" };
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { error: "photoMissing" };
  const image = await readTeacherPhoto(file);
  if (!image.ok) return { error: image.error };

  const state = await eachBranch(targets, (ctx, membershipId) =>
    setTeacherPhoto({ centerId: ctx.center.id, actorUserId: ctx.user.id, by: "teacher" }, membershipId, image),
  );
  revalidateProfile(locale);
  return state;
}

export async function removeOwnTeacherPhotoAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = ownTeacherPhotoSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { centerId, allBranches, locale } = parsed.data;

  // The named branch, re-resolved through the actor's own relations (SEC-44) —
  // or, for "all my branches", every branch they hold an active TEACHER role at.
  const targets = allBranches
    ? ((await teacherActionScope())?.contexts ?? [])
    : [await teacherBranchContext(centerId)].filter((ctx): ctx is TenantContext => ctx !== null);
  if (targets.length === 0) return FORBIDDEN;

  const state = await eachBranch(targets, (ctx, membershipId) =>
    clearTeacherPhoto({ centerId: ctx.center.id, actorUserId: ctx.user.id, by: "teacher" }, membershipId),
  );
  revalidateProfile(locale);
  return state.error ? state : { status: "deleted" };
}

export async function updateOwnClassCoverAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = ownClassCoverSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { centerId, classGroupId, locale } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return FORBIDDEN;

  if (!mediaUploadsEnabled()) return { error: "mediaNotConnected" };
  const file = formData.get("cover");
  if (!(file instanceof File) || file.size === 0) return { error: "photoMissing" };
  const checked = await readRasterImage(file, MAX_COVER_BYTES);
  if (!checked.ok) return { error: checked.error };

  // Re-found at this branch and pinned to this teacher: a class at another
  // branch, or another teacher's class here, is simply "not found".
  const classGroup = await scoped(ctx).classGroups.findById(classGroupId);
  if (!classGroup || classGroup.teacherId !== ctx.user.id) return NOT_FOUND;

  const result = await setClassCover(
    { centerId: ctx.center.id, actorUserId: ctx.user.id, by: "teacher" },
    classGroup.id,
    file,
  );
  if (!result.ok) return { error: result.error };

  revalidateProfile(locale);
  return { status: "saved" };
}

export async function removeOwnClassCoverAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = ownClassCoverSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;
  const { centerId, classGroupId, locale } = parsed.data;

  const ctx = await teacherBranchContext(centerId);
  if (!ctx) return FORBIDDEN;

  const classGroup = await scoped(ctx).classGroups.findById(classGroupId);
  if (!classGroup || classGroup.teacherId !== ctx.user.id) return NOT_FOUND;

  const result = await clearClassCover(
    { centerId: ctx.center.id, actorUserId: ctx.user.id, by: "teacher" },
    classGroup.id,
  );
  if (!result.ok) return { error: result.error };

  revalidateProfile(locale);
  return { status: "deleted" };
}
