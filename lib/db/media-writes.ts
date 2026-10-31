import { writeAuditLog } from "@/lib/db/audit";
import { prisma } from "@/lib/db/client";
import { classCoverKeyOf, setClassCoverKey, setTeacherPhotoKey, teacherPhotoKeyById } from "@/lib/db/media";
import { readRasterImage, removeStoredObject, storeTeacherPhoto, uploadClassCover } from "@/lib/db/storage";
import { logBestEffort } from "@/lib/log";
import { AVATARS_BUCKET, LOGOS_BUCKET, MAX_PHOTO_BYTES, isPathInCenter } from "@/lib/storage-paths";

/**
 * The writes behind a teacher's photo and a class cover (U9) — one place, so
 * the branch's screens and the teacher's own portal cannot drift apart. The
 * caller has already resolved the actor's context for **this** `centerId` and
 * checked its permission (`teacher.manage` / `class.manage`, or "this is my own
 * row" for the teacher's portal); nothing here trusts an id it was not handed
 * through that context.
 *
 * Order: the new object is stored first, then the row's key and the audit row
 * commit in one transaction, then the replaced object is deleted (best effort —
 * a stray object is harmless, a dangling key is not). Audit rows carry ids and
 * flags only (D-20): `teacher.photo.update|remove`, `classGroup.cover.update|remove`.
 */

export type MediaWriteResult = { ok: true } | { ok: false; error: string };

type Actor = { centerId: string; actorUserId: string; by: "teacher" | "branch" };

/** An image already read and typed from its bytes (`readRasterImage`), so one upload can go to several branches. */
export type CheckedImage = { bytes: Uint8Array; type: string; extension: string };

/** Reads a teacher-photo upload: PNG/JPEG/WebP by its bytes, about 1 MB. */
export async function readTeacherPhoto(file: File) {
  return readRasterImage(file, MAX_PHOTO_BYTES);
}

export async function setTeacherPhoto(actor: Actor, membershipId: string, image: CheckedImage): Promise<MediaWriteResult> {
  const current = await teacherPhotoKeyById(prisma, actor.centerId, membershipId);
  if (!current) return { ok: false, error: "notFound" };

  const stored = await storeTeacherPhoto(actor.centerId, membershipId, image);
  if (!stored.ok) return { ok: false, error: stored.error };

  await prisma.$transaction(async (tx) => {
    await setTeacherPhotoKey(tx, actor.centerId, membershipId, stored.path);
    await writeAuditLog(
      {
        centerId: actor.centerId,
        actorUserId: actor.actorUserId,
        action: "teacher.photo.update",
        entityType: "Membership",
        entityId: membershipId,
        before: { hadPhoto: Boolean(current.photoKey) },
        after: { hasPhoto: true, by: actor.by },
      },
      tx,
    );
  });

  if (current.photoKey && isPathInCenter(actor.centerId, current.photoKey)) {
    await removeStoredObject(actor.centerId, AVATARS_BUCKET, current.photoKey).catch(
      logBestEffort("replaced teacher photo clean-up"),
    );
  }
  return { ok: true };
}

export async function clearTeacherPhoto(actor: Actor, membershipId: string): Promise<MediaWriteResult> {
  const current = await teacherPhotoKeyById(prisma, actor.centerId, membershipId);
  if (!current) return { ok: false, error: "notFound" };
  if (!current.photoKey) return { ok: true };

  await prisma.$transaction(async (tx) => {
    await setTeacherPhotoKey(tx, actor.centerId, membershipId, null);
    await writeAuditLog(
      {
        centerId: actor.centerId,
        actorUserId: actor.actorUserId,
        action: "teacher.photo.remove",
        entityType: "Membership",
        entityId: membershipId,
        before: { hadPhoto: true },
        after: { hasPhoto: false, by: actor.by },
      },
      tx,
    );
  });

  if (isPathInCenter(actor.centerId, current.photoKey)) {
    await removeStoredObject(actor.centerId, AVATARS_BUCKET, current.photoKey).catch(
      logBestEffort("removed teacher photo clean-up"),
    );
  }
  return { ok: true };
}

export async function setClassCover(actor: Actor, classGroupId: string, file: File): Promise<MediaWriteResult> {
  const previous = await classCoverKeyOf(prisma, actor.centerId, classGroupId);
  if (previous === undefined) return { ok: false, error: "notFound" };

  const uploaded = await uploadClassCover(actor.centerId, classGroupId, file);
  if (!uploaded.ok) return { ok: false, error: uploaded.error };

  await prisma.$transaction(async (tx) => {
    await setClassCoverKey(tx, actor.centerId, classGroupId, uploaded.path);
    await writeAuditLog(
      {
        centerId: actor.centerId,
        actorUserId: actor.actorUserId,
        action: "classGroup.cover.update",
        entityType: "ClassGroup",
        entityId: classGroupId,
        before: { hadCover: Boolean(previous) },
        after: { hasCover: true, by: actor.by },
      },
      tx,
    );
  });

  if (previous && isPathInCenter(actor.centerId, previous)) {
    await removeStoredObject(actor.centerId, LOGOS_BUCKET, previous).catch(logBestEffort("replaced class cover clean-up"));
  }
  return { ok: true };
}

export async function clearClassCover(actor: Actor, classGroupId: string): Promise<MediaWriteResult> {
  const previous = await classCoverKeyOf(prisma, actor.centerId, classGroupId);
  if (previous === undefined) return { ok: false, error: "notFound" };
  if (!previous) return { ok: true };

  await prisma.$transaction(async (tx) => {
    await setClassCoverKey(tx, actor.centerId, classGroupId, null);
    await writeAuditLog(
      {
        centerId: actor.centerId,
        actorUserId: actor.actorUserId,
        action: "classGroup.cover.remove",
        entityType: "ClassGroup",
        entityId: classGroupId,
        before: { hadCover: true },
        after: { hasCover: false, by: actor.by },
      },
      tx,
    );
  });

  if (isPathInCenter(actor.centerId, previous)) {
    await removeStoredObject(actor.centerId, LOGOS_BUCKET, previous).catch(logBestEffort("removed class cover clean-up"));
  }
  return { ok: true };
}
