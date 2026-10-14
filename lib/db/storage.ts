import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  AVATARS_BUCKET,
  ID_CARDS_BUCKET,
  LOGOS_BUCKET,
  MAX_LOGO_BYTES,
  MAX_PHOTO_BYTES,
  assertPathInCenter,
  centerLogoPath,
  photoExtensionFor,
  sniffImageType,
  studentIdCardPath,
  studentPhotoPath,
  type StorageBucket,
} from "@/lib/storage-paths";

/**
 * Tenant-scoped file access (docs/02-architecture.md §10).
 *
 * The rule mirrors `lib/db/scoped.ts`: nothing reaches Storage without a
 * resolved `centerId`. Paths are built by `centerObjectPath()` and any path
 * read back from the database is re-checked with `assertPathInCenter()` before
 * it is signed, downloaded or deleted — a stored path pointing at another
 * center is refused, not served.
 */

/** How long a card/photo link stays valid. Long enough to print, not to share. */
const SIGNED_URL_TTL_SECONDS = 60 * 10;

export type StoredPhoto = { path: string };

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

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.storage
    .from(AVATARS_BUCKET)
    .upload(path, bytes, { contentType: type, upsert: true });

  return error ? { ok: false, error: "storage" } : { ok: true, path };
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
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.storage
    .from(LOGOS_BUCKET)
    .upload(path, image.bytes, { contentType: image.type, upsert: true });
  return error ? { ok: false, error: "storage" } : { ok: true, path };
}

/** Writes the generated card. Deterministic path — regenerating replaces it. */
export async function uploadIdCard(
  centerId: string,
  studentProfileId: string,
  svg: string,
): Promise<{ ok: true; path: string } | { ok: false; error: "storage" }> {
  const path = studentIdCardPath(centerId, studentProfileId);
  const supabase = createSupabaseAdminClient();

  const { error } = await supabase.storage
    .from(ID_CARDS_BUCKET)
    .upload(path, new Blob([svg], { type: "image/svg+xml" }), {
      contentType: "image/svg+xml",
      upsert: true,
    });

  return error ? { ok: false, error: "storage" } : { ok: true, path };
}

export async function signedUrlFor(
  centerId: string,
  bucket: StorageBucket,
  path: string,
): Promise<string | null> {
  assertPathInCenter(centerId, path);
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  return error ? null : (data?.signedUrl ?? null);
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
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return null;

  // Only a raster image is ever inlined into a card, whatever was stored:
  // the type comes from the bytes (SEC-54), not the object's metadata.
  const bytes = new Uint8Array(await data.arrayBuffer());
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
  const supabase = createSupabaseAdminClient();
  await supabase.storage.from(bucket).remove([path]);
}

/** When a student's card was last generated, or null if there isn't one. */
export async function idCardGeneratedAt(
  centerId: string,
  studentProfileId: string,
): Promise<Date | null> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.storage
    .from(ID_CARDS_BUCKET)
    .list(centerId, { search: `${studentProfileId}.svg`, limit: 1 });

  if (error || !data || data.length === 0) return null;
  const stamp = data[0].updated_at ?? data[0].created_at;
  return stamp ? new Date(stamp) : null;
}
