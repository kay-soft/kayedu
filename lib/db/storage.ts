import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  AVATARS_BUCKET,
  ID_CARDS_BUCKET,
  MAX_PHOTO_BYTES,
  assertPathInCenter,
  photoExtensionFor,
  studentIdCardPath,
  studentPhotoPath,
  type PeopleBucket,
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

export async function uploadStudentPhoto(
  centerId: string,
  studentProfileId: string,
  file: File,
): Promise<
  { ok: true; path: string } | { ok: false; error: "photoType" | "photoTooLarge" | "storage" }
> {
  const extension = photoExtensionFor(file.type);
  if (!extension) return { ok: false, error: "photoType" };
  if (file.size > MAX_PHOTO_BYTES) return { ok: false, error: "photoTooLarge" };

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
    .upload(path, file, { contentType: file.type, upsert: true });

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
  bucket: PeopleBucket,
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
  bucket: PeopleBucket,
  path: string,
): Promise<string | null> {
  assertPathInCenter(centerId, path);
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) return null;

  const buffer = Buffer.from(await data.arrayBuffer());
  const mime = data.type || "application/octet-stream";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/** Fetches a remote image (the center logo) as a data URI for the card. */
export async function remoteImageAsDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_PHOTO_BYTES) return null;
    return `data:${type};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

export async function removeStoredObject(
  centerId: string,
  bucket: PeopleBucket,
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
