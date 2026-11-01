import { storage } from "@/lib/storage";
import {
  AVATARS_BUCKET,
  ID_CARDS_BUCKET,
  LOGOS_BUCKET,
  MAX_COVER_BYTES,
  MAX_LOGO_BYTES,
  MAX_PHOTO_BYTES,
  assertPathInCenter,
  centerLogoPath,
  classCoverPath,
  photoExtensionFor,
  sniffImageType,
  studentIdCardPath,
  studentPhotoPath,
  teacherPhotoPath,
  type StorageBucket,
} from "@/lib/storage-paths";

/**
 * Tenant-scoped file access (docs/02-architecture.md §10).
 *
 * SYS: the provider is behind `lib/storage` (`storage()` — today the
 * Supabase adapter); this module never names a provider. It is the policy
 * layer every caller uses: keys built here, re-checked against the centre,
 * uploads typed by their bytes — then handed to the provider.
 *
 * The rule mirrors `lib/db/scoped.ts`: nothing reaches Storage without a
 * resolved `centerId`. Paths are built by `centerObjectPath()` and any path
 * read back from the database is re-checked with `assertPathInCenter()` before
 * it is signed, downloaded or deleted — a stored path pointing at another
 * center is refused, not served.
 */

/** How long a card/photo link stays valid. Long enough to print, not to share. */
const SIGNED_URL_TTL_SECONDS = 60 * 10;

type UploadRefusal = "photoType" | "photoTooLarge" | "storage";

/**
 * Reads an uploaded image and decides its type from its **bytes** (SEC-54):
 * PNG/JPEG/WebP only, whatever `File.type` claims, under `maxBytes`. The
 * stored object's content type is the sniffed one.
 */
export async function readRasterImage(
  file: File,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array; type: string; extension: string } | { ok: false; error: UploadRefusal }> {
  if (file.size > maxBytes) return { ok: false, error: "photoTooLarge" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { ok: false, error: "photoTooLarge" };
  const type = sniffImageType(bytes);
  const extension = type ? photoExtensionFor(type) : null;
  if (!type || !extension) return { ok: false, error: "photoType" };
  return { ok: true, bytes, type, extension };
}

export async function uploadStudentPhoto(
  centerId: string,
  studentProfileId: string,
  file: File,
): Promise<{ ok: true; path: string } | { ok: false; error: UploadRefusal }> {
  const image = await readRasterImage(file, MAX_PHOTO_BYTES);
  if (!image.ok) return image;
  const { bytes, type, extension } = image;

  // The version suffix busts any cached copy of a replaced photo; the filename
  // stem stays the profile id, which is what the read policy matches on.
  const path = studentPhotoPath(
    centerId,
    studentProfileId,
    extension,
    Date.now().toString(36),
  );

  const stored = await storage().upload(AVATARS_BUCKET, path, bytes, type);
  return stored ? { ok: true, path } : { ok: false, error: "storage" };
}

/**
 * A centre's logo (D-25 (b)) — into the private `logos` bucket under the
 * centre's own folder, raster only by its bytes, size-capped. Served only
 * through `/api/logos/[centerId]` as a short-lived signed URL.
 */
export async function uploadCenterLogo(
  centerId: string,
  file: File,
): Promise<{ ok: true; path: string } | { ok: false; error: UploadRefusal }> {
  const image = await readRasterImage(file, MAX_LOGO_BYTES);
  if (!image.ok) return image;
  const path = centerLogoPath(centerId, image.extension, Date.now().toString(36));
  const stored = await storage().upload(LOGOS_BUCKET, path, image.bytes, image.type);
  return stored ? { ok: true, path } : { ok: false, error: "storage" };
}

/**
 * A teacher's photo at one branch (U9) — into the private `avatars` bucket
 * under the branch's own folder, raster only by its bytes, about 1 MB. The
 * stem is the Membership id; the version busts cached copies of a replaced one.
 */
export async function uploadTeacherPhoto(
  centerId: string,
  membershipId: string,
  file: File,
): Promise<{ ok: true; path: string } | { ok: false; error: UploadRefusal }> {
  const image = await readRasterImage(file, MAX_PHOTO_BYTES);
  if (!image.ok) return image;
  return storeTeacherPhoto(centerId, membershipId, image);
}

/** Writes one already-checked image under a branch's folder — also the "all my branches" copy. */
export async function storeTeacherPhoto(
  centerId: string,
  membershipId: string,
  image: { bytes: Uint8Array; type: string; extension: string },
): Promise<{ ok: true; path: string } | { ok: false; error: UploadRefusal }> {
  const path = teacherPhotoPath(centerId, membershipId, image.extension, Date.now().toString(36));
  const stored = await storage().upload(AVATARS_BUCKET, path, image.bytes, image.type);
  return stored ? { ok: true, path } : { ok: false, error: "storage" };
}

/** A class cover (U9) — into the private `logos` bucket under the branch's folder, 512 KB. */
export async function uploadClassCover(
  centerId: string,
  classGroupId: string,
  file: File,
): Promise<{ ok: true; path: string } | { ok: false; error: UploadRefusal }> {
  const image = await readRasterImage(file, MAX_COVER_BYTES);
  if (!image.ok) return image;
  const path = classCoverPath(centerId, classGroupId, image.extension, Date.now().toString(36));
  const stored = await storage().upload(LOGOS_BUCKET, path, image.bytes, image.type);
  return stored ? { ok: true, path } : { ok: false, error: "storage" };
}

/** Writes the generated card. Deterministic path — regenerating replaces it. */
export async function uploadIdCard(
  centerId: string,
  studentProfileId: string,
  svg: string,
): Promise<{ ok: true; path: string } | { ok: false; error: "storage" }> {
  const path = studentIdCardPath(centerId, studentProfileId);
  const stored = await storage().upload(
    ID_CARDS_BUCKET,
    path,
    new Blob([svg], { type: "image/svg+xml" }),
    "image/svg+xml",
  );
  return stored ? { ok: true, path } : { ok: false, error: "storage" };
}

export async function signedUrlFor(
  centerId: string,
  bucket: StorageBucket,
  path: string,
): Promise<string | null> {
  assertPathInCenter(centerId, path);
  return storage().signedUrl(bucket, path, SIGNED_URL_TTL_SECONDS);
}

/**
 * Inlines an object as a data URI. The generated card must be self-contained —
 * a stored SVG that referenced a signed URL would stop rendering when the
 * signature expired.
 */
export async function objectAsDataUri(
  centerId: string,
  bucket: StorageBucket,
  path: string,
): Promise<string | null> {
  assertPathInCenter(centerId, path);
  const bytes = await storage().download(bucket, path);
  if (!bytes) return null;

  // Only a raster image is ever inlined into a card, whatever was stored:
  // the type comes from the bytes (SEC-54), not the object's metadata.
  const mime = sniffImageType(bytes);
  if (!mime) return null;
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

export async function removeStoredObject(
  centerId: string,
  bucket: StorageBucket,
  path: string,
): Promise<void> {
  assertPathInCenter(centerId, path);
  await storage().remove(bucket, [path]);
}

/** When a student's card was last generated, or null if there isn't one. */
export async function idCardGeneratedAt(
  centerId: string,
  studentProfileId: string,
): Promise<Date | null> {
  return storage().lastModified(ID_CARDS_BUCKET, studentIdCardPath(centerId, studentProfileId));
}
