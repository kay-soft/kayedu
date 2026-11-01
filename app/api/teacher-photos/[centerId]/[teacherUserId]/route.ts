import { NextResponse } from "next/server";

import { getAuthUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { accessibleCenterId, teacherPhotoKeyAt } from "@/lib/db/media";
import { publicTeacherPhotoKey } from "@/lib/db/public-catalog";
import { signedUrlFor } from "@/lib/db/storage";
import { logBestEffort } from "@/lib/log";
import { AVATARS_BUCKET, isPathInCenter } from "@/lib/storage-paths";

/**
 * A teacher's photo at one branch (U9) — the `/api/logos` pattern: the photo
 * is a private object, this route re-reads **this** branch's stored key,
 * refuses one outside the branch's own folder and redirects to a 10-minute
 * signed URL.
 *
 * Signed in: any branch that may operate. A guest gets it only for a teacher
 * with a listed class at a listed branch (`publicTeacherPhotoKey`); anything
 * else is a 404, so the route cannot be used to probe who works where.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ centerId: string; teacherUserId: string }> },
) {
  const { centerId, teacherUserId } = await params;
  const notFound = new NextResponse(null, { status: 404 });

  const signedIn = Boolean(await getAuthUser());
  let key: string | null = null;
  if (signedIn) {
    key = (await accessibleCenterId(prisma, centerId))
      ? ((await teacherPhotoKeyAt(prisma, centerId, teacherUserId))?.photoKey ?? null)
      : null;
  } else {
    key = await publicTeacherPhotoKey(prisma, centerId, teacherUserId, new Date());
  }
  if (!key || !isPathInCenter(centerId, key)) return notFound;

  const signed = await signedUrlFor(centerId, AVATARS_BUCKET, key).catch(
    (error: unknown) => logBestEffort("teacher photo signed URL")(error) ?? null,
  );
  if (!signed) return notFound;

  const response = NextResponse.redirect(signed, 302);
  response.headers.set(
    "Cache-Control",
    signedIn ? "private, max-age=300" : "public, max-age=300, s-maxage=300",
  );
  return response;
}
