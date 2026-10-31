import { NextResponse } from "next/server";

import { getAuthUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { accessibleCenterId, classImageSource } from "@/lib/db/media";
import { publicClassImage } from "@/lib/db/public-catalog";
import { signedUrlFor } from "@/lib/db/storage";
import { logBestEffort } from "@/lib/log";
import { isPathInCenter, pickClassImage, type ClassImage } from "@/lib/storage-paths";

/**
 * A class's image (U9): its cover, else the teacher's photo at that branch.
 * Both live in private buckets; this route is the only way one reaches a
 * browser. It re-reads **this** branch's stored key, refuses a key outside the
 * branch's own folder, and redirects to a short-lived signed URL — the
 * `/api/logos` pattern (SEC-53).
 *
 * A signed-in request gets the image of a class at any branch that may operate
 * (the cards and pages they can open). A guest (F5) gets one only for a class
 * on the public Explore pages — a listed branch's listed class; every other
 * guest request is a 404. Under `/api` so no locale redirect sits in front of
 * an `<img>`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ centerId: string; classId: string }> },
) {
  const { centerId, classId } = await params;
  const notFound = new NextResponse(null, { status: 404 });

  const signedIn = Boolean(await getAuthUser());
  let image: ClassImage | null = null;
  if (signedIn) {
    if (await accessibleCenterId(prisma, centerId)) {
      const source = await classImageSource(prisma, centerId, classId);
      image = source ? pickClassImage(source) : null;
    }
  } else {
    image = await publicClassImage(prisma, centerId, classId, new Date());
  }
  if (!image || !isPathInCenter(centerId, image.key)) return notFound;

  const signed = await signedUrlFor(centerId, image.bucket, image.key).catch(
    (error: unknown) => logBestEffort("class image signed URL")(error) ?? null,
  );
  if (!signed) return notFound;

  const response = NextResponse.redirect(signed, 302);
  // Shorter than the signature's own life (10 minutes); a guest's copy may sit
  // in a shared cache only this briefly, so unlisting takes effect in minutes.
  response.headers.set(
    "Cache-Control",
    signedIn ? "private, max-age=300" : "public, max-age=300, s-maxage=300",
  );
  return response;
}
