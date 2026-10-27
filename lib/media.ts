/**
 * Media switches (F8). Server-only env, read at request time.
 *
 * - `MEDIA_UPLOADS_ENABLED` (default off): until the media provider
 *   (Cloudinary, behind `lib/storage`) is connected, the logo and profile-photo
 *   screens validate a file exactly as they will later, then refuse to store it
 *   ("not connected yet") — nothing is written anywhere.
 * - `MEDIA_AVATARS_DISPLAY` (default off): off, a profile photo shows only on
 *   the Account page's own preview and everywhere else keeps initials; on, it
 *   also shows in the user menu, teacher cards and rosters.
 */

function flag(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

export function mediaUploadsEnabled(): boolean {
  return flag("MEDIA_UPLOADS_ENABLED");
}

export function avatarsDisplayEnabled(): boolean {
  return flag("MEDIA_AVATARS_DISPLAY");
}

/**
 * The profile photo to show *outside* the Account page: the photo's `src` when
 * the display flag is on, otherwise null so the caller falls back to initials.
 * Profile photos have no storage destination yet (no column holds a key —
 * propose-first, docs/02 §10), so `src` is always null for now; the gate is
 * here so every caller already goes through the flag.
 */
export function profilePhotoForDisplay(src: string | null | undefined): string | null {
  return avatarsDisplayEnabled() && src ? src : null;
}
