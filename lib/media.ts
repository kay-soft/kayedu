/**
 * Media switch (F8, U9). Server-only env, read at request time.
 *
 * `MEDIA_UPLOADS_ENABLED` (default off) gates every image upload — the branch
 * logo, a teacher's photo and a class cover. Off, the controls say "Coming
 * soon" and the actions refuse (`mediaNotConnected`): nothing is stored, nothing
 * is audited. On, files go to Supabase Storage through `lib/storage` (Cloudinary
 * later is a change inside that seam, M20).
 *
 * `MEDIA_AVATARS_DISPLAY` is gone (U9): personal profile photos were removed.
 */

export function mediaUploadsEnabled(): boolean {
  return process.env.MEDIA_UPLOADS_ENABLED?.trim().toLowerCase() === "true";
}
