"use server";

import { revalidatePath } from "next/cache";

import { PICK_BRANCH, isPickBranch, requireBranchScope } from "@/lib/auth/branch-scope";
import { ctxCan, getTenantContext } from "@/lib/auth/tenant";
import { clearClassCover, setClassCover } from "@/lib/db/media-writes";
import { scoped } from "@/lib/db/scoped";
import { readRasterImage } from "@/lib/db/storage";
import { mediaUploadsEnabled } from "@/lib/media";
import { ROUTES } from "@/lib/routes";
import { MAX_COVER_BYTES } from "@/lib/storage-paths";
import type { ActionState } from "@/lib/validation/form";
import { classCoverSchema } from "@/lib/validation/media";

/**
 * A class's cover image, set by the branch (U9). `class.manage`, the same gate
 * as the class page; the class is re-found through the branch's own scoped
 * helper. Typed by the bytes (PNG/JPEG/WebP, 512 KB), shrunk in the browser
 * first. Audited `classGroup.cover.update` / `classGroup.cover.remove` (ids
 * only). While `MEDIA_UPLOADS_ENABLED` is off nothing is stored or audited.
 */

const FORBIDDEN: ActionState = { error: "forbidden" };
const NOT_FOUND: ActionState = { error: "notFound" };

async function scope() {
  const ctx = await getTenantContext("center");
  if (requireBranchScope(ctx)) return PICK_BRANCH;
  return ctxCan(ctx, "class.manage") ? ctx : null;
}

export async function updateClassCoverAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await scope();
  if (isPickBranch(ctx) || !ctx) return FORBIDDEN;
  const parsed = classCoverSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  if (!mediaUploadsEnabled()) return { error: "mediaNotConnected" };
  const file = formData.get("cover");
  if (!(file instanceof File) || file.size === 0) return { error: "photoMissing" };
  const checked = await readRasterImage(file, MAX_COVER_BYTES);
  if (!checked.ok) return { error: checked.error };

  const classGroup = await scoped(ctx).classGroups.findById(parsed.data.classGroupId);
  if (!classGroup) return NOT_FOUND;

  const result = await setClassCover(
    { centerId: ctx.center.id, actorUserId: ctx.user.id, by: "branch" },
    classGroup.id,
    file,
  );
  if (!result.ok) return { error: result.error };

  revalidatePath(`/${parsed.data.locale}${ROUTES.centerClass(classGroup.id)}`);
  return { status: "saved" };
}

export async function removeClassCoverAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await scope();
  if (isPickBranch(ctx) || !ctx) return FORBIDDEN;
  const parsed = classCoverSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return NOT_FOUND;

  const classGroup = await scoped(ctx).classGroups.findById(parsed.data.classGroupId);
  if (!classGroup) return NOT_FOUND;

  const result = await clearClassCover(
    { centerId: ctx.center.id, actorUserId: ctx.user.id, by: "branch" },
    classGroup.id,
  );
  if (!result.ok) return { error: result.error };

  revalidatePath(`/${parsed.data.locale}${ROUTES.centerClass(classGroup.id)}`);
  return { status: "deleted" };
}
