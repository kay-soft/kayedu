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

export type PeopleBucket = typeof AVATARS_BUCKET | typeof ID_CARDS_BUCKET;

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

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

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

/** A generated ID card. Deterministic: regenerating replaces the same object. */
export function studentIdCardPath(
  centerId: string,
  studentProfileId: string,
): string {
  return centerObjectPath(centerId, `${studentProfileId}.svg`);
}
