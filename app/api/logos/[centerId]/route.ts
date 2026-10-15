import { NextResponse } from "next/server";

import { getAuthUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { signedUrlFor } from "@/lib/db/storage";
import { LOGOS_BUCKET, isPathInCenter } from "@/lib/storage-paths";
import { logBestEffort } from "@/lib/log";
import { centerLogoPath } from "@/lib/db/platform";

/**
 * A centre's logo (SEC-2a, D-25 (b), SEC-53). Logos live in the private
 * `logos` bucket; this route is the only way one reaches a browser: it looks
 * up **this** centre's stored path, refuses anything outside the centre's own
 * folder, and redirects to a short-lived signed URL. Every place a logo is
 * shown is behind sign-in, so an anonymous request gets nothing.
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

  if (!(await getAuthUser())) return notFound;

  const center = await centerLogoPath(prisma, centerId);
  if (!center?.logoPath || !isPathInCenter(center.id, center.logoPath)) return notFound;

  const signed = await signedUrlFor(center.id, LOGOS_BUCKET, center.logoPath).catch(
    (error: unknown) => logBestEffort("logo signed URL")(error) ?? null,
  );
  if (!signed) return notFound;

  const response = NextResponse.redirect(signed, 302);
  // Shorter than the signature's own lifetime, private to this browser.
  response.headers.set("Cache-Control", "private, max-age=300");
  return response;
}
