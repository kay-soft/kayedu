import { NextResponse } from "next/server";

import { getAuthUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { signedUrlFor } from "@/lib/db/storage";
import { LOGOS_BUCKET, isPathInCenter } from "@/lib/storage-paths";
import { logBestEffort } from "@/lib/log";
import { centerLogoPath } from "@/lib/db/platform";
import { publicBranchLogo } from "@/lib/db/public-catalog";

/**
 * A centre's logo (SEC-2a, D-25 (b), SEC-53). Logos live in the private
 * `logos` bucket; this route is the only way one reaches a browser: it looks
 * up **this** centre's stored path, refuses anything outside the centre's own
 * folder, and redirects to a short-lived signed URL.
 *
 * A signed-in request gets any centre's logo, as before. A guest (F5) gets a
 * logo only for a branch on the public Explore pages — ACTIVE/GRACE and
 * `publicListing` (`lib/db/public-catalog.ts`); every other guest request is
 * a 404, exactly as before F5.
 *
 * Under `/api` on purpose: the proxy's matcher skips it, so no locale
 * redirect sits in front of an `<img>` request.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ centerId: string }> },
) {
  const { centerId } = await params;
  const notFound = new NextResponse(null, { status: 404 });

  const signedIn = Boolean(await getAuthUser());
  const center = signedIn
    ? await centerLogoPath(prisma, centerId)
    : await publicBranchLogo(prisma, centerId);
  if (!center?.logoPath || !isPathInCenter(center.id, center.logoPath)) return notFound;

  const signed = await signedUrlFor(center.id, LOGOS_BUCKET, center.logoPath).catch(
    (error: unknown) => logBestEffort("logo signed URL")(error) ?? null,
  );
  if (!signed) return notFound;

  const response = NextResponse.redirect(signed, 302);
  // Shorter than the signature's own lifetime (10 minutes). A guest's logo is
  // a listed branch's public mark, so it may sit in a shared cache — but only
  // as briefly as this, so unlisting a branch takes effect within minutes.
  response.headers.set(
    "Cache-Control",
    signedIn ? "private, max-age=300" : "public, max-age=300, s-maxage=300",
  );
  return response;
}
