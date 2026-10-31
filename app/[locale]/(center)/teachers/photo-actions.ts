"use server";

import { revalidatePath } from "next/cache";

import { PICK_BRANCH, isPickBranch, requireBranchScope } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { clearTeacherPhoto, readTeacherPhoto, setTeacherPhoto } from "@/lib/db/media-writes";
import { scoped } from "@/lib/db/scoped";
import { mediaUploadsEnabled } from "@/lib/media";
import { ROUTES } from "@/lib/routes";
import type { ActionState } from "@/lib/validation/form";
import { teacherPhotoSchema } from "@/lib/validation/media";

/**
 * A teacher's photo at this branch, set by the branch (U9). `teacher.manage`,
 * the same gate as the teacher page; the membership is re-found through the
 * branch's own scoped helper, so a teacher of another branch is "not found".
 * Typed by the bytes (PNG/JPEG/WebP, about 1 MB), shrunk in the browser first.
 * Audited `teacher.photo.update` / `teacher.photo.remove` (ids only). While
 * `MEDIA_UPLOADS_ENABLED` is off nothing is read, stored or audited.
 */

const FORBIDDEN: ActionState = { error: "forbidden" };
const NOT_FOUND: ActionState = { error: "notFound" };

async function scope() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return PICK_BRANCH;
  return ctxCan(ctx, "teacher.manage") ? ctx : null;
}

export async function updateTeacherPhotoAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await scope();
  if (isPickBranch(ctx) || !ctx) return FORBIDDEN;
  const parsed = teacherPhotoSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  if (!mediaUploadsEnabled()) return { error: "mediaNotConnected" };
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { error: "photoMissing" };
  const image = await readTeacherPhoto(file);
  if (!image.ok) return { error: image.error };

  const teacher = await scoped(ctx).teachers.findById(parsed.data.membershipId);
  if (!teacher) return NOT_FOUND;

  const result = await setTeacherPhoto(
    { centerId: ctx.center.id, actorUserId: ctx.user.id, by: "branch" },
    teacher.id,
    image,
  );
  if (!result.ok) return { error: result.error };

  revalidatePath(`/${parsed.data.locale}${ROUTES.centerTeacher(teacher.id)}`);
  return { status: "saved" };
}

export async function removeTeacherPhotoAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await scope();
  if (isPickBranch(ctx) || !ctx) return FORBIDDEN;
  const parsed = teacherPhotoSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const teacher = await scoped(ctx).teachers.findById(parsed.data.membershipId);
  if (!teacher) return NOT_FOUND;

  const result = await clearTeacherPhoto(
    { centerId: ctx.center.id, actorUserId: ctx.user.id, by: "branch" },
    teacher.id,
  );
  if (!result.ok) return { error: result.error };

  revalidatePath(`/${parsed.data.locale}${ROUTES.centerTeacher(teacher.id)}`);
  return { status: "deleted" };
}
