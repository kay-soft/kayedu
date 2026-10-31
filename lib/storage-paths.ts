/**
 * Storage path primitives — the tenant boundary for Supabase Storage
 * (docs/02-architecture.md §10, and §5 layer 1 applied to files).
 *
 * This module deliberately has **no runtime imports**: it is the piece the
 * people check (`npm run check:people`) exercises directly, exactly like
 * lib/db/tenant-scope.ts does for queries.
 *
 * Rule: every object path starts with the active `centerId`. A path is only
 * ever built with `centerObjectPath()` and only ever read back after
 * `assertPathInCenter()` — a path from another center must be refused, not
 * signed. The Postgres storage policies mirror this as a backstop.
 */

export const AVATARS_BUCKET = "avatars";
export const ID_CARDS_BUCKET = "id-cards";
/** Centre logos (SEC-2a, D-25 (b)) — private like the others, served signed. */
export const LOGOS_BUCKET = "logos";

export type PeopleBucket = typeof AVATARS_BUCKET | typeof ID_CARDS_BUCKET;
export type StorageBucket = PeopleBucket | typeof LOGOS_BUCKET;

export class StoragePathError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = "StoragePathError";
    this.path = path;
  }
}

/** Rejects anything that could climb out of the center's folder. */
function assertSafeSegment(segment: string): string {
  const value = segment.trim();
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..")
  ) {
    throw new StoragePathError("Unsafe storage path segment.", segment);
  }
  return value;
}

/**
 * `{centerId}/{…segments}` — the only way a storage path is ever built.
 * Throws (never falls back to an unscoped path) when there is no centerId,
 * the same way scopedWhere() refuses an unscoped query.
 */
export function centerObjectPath(
  centerId: string,
  ...segments: string[]
): string {
  if (!centerId || centerId.trim().length === 0) {
    throw new StoragePathError(
      "A storage path was built without a centerId. Resolve one with getTenantContext() first.",
      segments.join("/"),
    );
  }
  return [assertSafeSegment(centerId), ...segments.map(assertSafeSegment)].join(
    "/",
  );
}

/** True when `path` lives under this center's folder — no partial matches. */
export function isPathInCenter(centerId: string, path: string): boolean {
  if (!centerId || !path) return false;
  return path.startsWith(`${centerId}/`) && !path.includes("..");
}

/**
 * Guards a path that came back from the database before it is signed, read or
 * deleted. A stored path pointing at another center is a bug, not a 404.
 */
export function assertPathInCenter(centerId: string, path: string): string {
  if (!isPathInCenter(centerId, path)) {
    throw new StoragePathError(
      `Storage path "${path}" is not in the active center.`,
      path,
    );
  }
  return path;
}

export type RasterImageType = "image/png" | "image/jpeg" | "image/webp";

/**
 * The image type the **bytes** say this is (SEC-54) — never the client's
 * `File.type`, which is whatever the browser (or an attacker) claims. PNG,
 * JPEG and WebP only: no SVG (it is a document that can carry script), no
 * GIF, nothing else. Returns null for anything that is not one of the three.
 */
export function sniffImageType(bytes: Uint8Array): RasterImageType | null {
  const at = (offset: number, ...expected: number[]) =>
    expected.every((value, index) => bytes[offset + index] === value);
  if (bytes.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    at(0, 0x52, 0x49, 0x46, 0x46) && // "RIFF"
    at(8, 0x57, 0x45, 0x42, 0x50) // "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Extension for an accepted photo upload, or null if the type is not allowed. */
export function photoExtensionFor(mimeType: string): string | null {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

/**
 * About 1 MB (SEC-64, D-27 (b)) — under Next's default 1 MB Server Action
 * body once the form's other fields are counted, so the limit a person sees is
 * the one that applies. The photo form shrinks a larger picture in the
 * browser before it is sent (`components/center/resize-image.ts`).
 */
export const MAX_PHOTO_BYTES = 1000 * 1024;

/** A centre logo (D-25): small, raster, uploaded by a platform admin. */
export const MAX_LOGO_BYTES = 512 * 1024;

/**
 * A student's photo. The filename stem is the StudentProfile id, which is what
 * the storage read policy matches on so a student can read their own file.
 * The suffix busts the CDN/browser cache when a photo is replaced.
 */
export function studentPhotoPath(
  centerId: string,
  studentProfileId: string,
  extension: string,
  version: string,
): string {
  return centerObjectPath(
    centerId,
    `${studentProfileId}.${version}.${extension}`,
  );
}

/** A centre's logo; the version suffix busts any cached copy when replaced. */
export function centerLogoPath(centerId: string, extension: string, version: string): string {
  return centerObjectPath(centerId, `logo.${version}.${extension}`);
}

/**
 * The `src` the UI renders for a centre logo (D-25 (b)): the app's own logo
 * route, which mints a short-lived signed URL for exactly this centre's
 * object — never a stored URL, never a public bucket. The stored path's
 * version is in the query so a replaced logo is not served from cache.
 */
export function centerLogoSrc(center: { id: string; logoPath: string | null }): string | null {
  if (!center.logoPath) return null;
  const version = center.logoPath.split("/").pop() ?? "";
  return `/api/logos/${encodeURIComponent(center.id)}?v=${encodeURIComponent(version)}`;
}

/** A class cover (U9): a wide picture, so it shares the logo bucket's 512 KB cap. */
export const MAX_COVER_BYTES = 512 * 1024;

/**
 * A teacher's photo at one branch (U9) — in the `avatars` bucket, under the
 * branch's own folder; the stem is the teacher's Membership id. The version
 * suffix busts any cached copy when replaced. A teacher who uses one photo at
 * every branch has one such object per branch: a key is never shared across
 * centres (`assertPathInCenter` would refuse it).
 */
export function teacherPhotoPath(
  centerId: string,
  membershipId: string,
  extension: string,
  version: string,
): string {
  return centerObjectPath(centerId, `teacher.${membershipId}.${version}.${extension}`);
}

/** A class cover (U9) — in the `logos` bucket, under the branch's own folder. */
export function classCoverPath(
  centerId: string,
  classGroupId: string,
  extension: string,
  version: string,
): string {
  return centerObjectPath(centerId, `cover.${classGroupId}.${version}.${extension}`);
}

/** The object's file name — it carries the version suffix, so it busts the cache when replaced. */
function keyVersion(key: string): string {
  return key.split("/").pop() ?? "";
}

/**
 * The `src` the UI renders for a teacher's photo (U9): the app's own route,
 * which mints a short-lived signed URL for exactly this branch's object —
 * never a stored key, never a public bucket (same pattern as `centerLogoSrc`).
 */
export function teacherPhotoSrc(
  centerId: string,
  teacherUserId: string,
  photoKey: string | null | undefined,
): string | null {
  if (!photoKey) return null;
  return `/api/teacher-photos/${encodeURIComponent(centerId)}/${encodeURIComponent(teacherUserId)}?v=${encodeURIComponent(keyVersion(photoKey))}`;
}

/** What a class card / class page shows as its image, in order: cover, then the teacher's photo. */
export type ClassImage = { kind: "cover" | "teacher"; bucket: StorageBucket; key: string };

export function pickClassImage(source: {
  coverKey: string | null | undefined;
  teacherPhotoKey: string | null | undefined;
}): ClassImage | null {
  if (source.coverKey) return { kind: "cover", bucket: LOGOS_BUCKET, key: source.coverKey };
  if (source.teacherPhotoKey) return { kind: "teacher", bucket: AVATARS_BUCKET, key: source.teacherPhotoKey };
  return null;
}

/**
 * The `src` for a class's image (U9): the cover, else the teacher's photo at
 * that branch, else null (the generated look). The route repeats the same
 * choice from the database; the version in the query changes with whichever
 * object is showing, so a replacement is not served from cache.
 */
export function classImageSrc(
  centerId: string,
  classGroupId: string,
  source: { coverKey: string | null | undefined; teacherPhotoKey: string | null | undefined },
): string | null {
  const image = pickClassImage(source);
  if (!image) return null;
  return `/api/class-images/${encodeURIComponent(centerId)}/${encodeURIComponent(classGroupId)}?v=${encodeURIComponent(keyVersion(image.key))}`;
}

/** A generated ID card. Deterministic: regenerating replaces the same object. */
export function studentIdCardPath(
  centerId: string,
  studentProfileId: string,
): string {
  return centerObjectPath(centerId, `${studentProfileId}.svg`);
}
