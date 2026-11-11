import { NextResponse, type NextRequest } from "next/server";

import { studentBranches } from "@/app/[locale]/(student)/student/assessments/scope";
import { getCurrentUser } from "@/lib/auth/session";
import { submitAttempt } from "@/lib/db/assessment-attempts";
import { prisma } from "@/lib/db/client";
import { logBestEffort } from "@/lib/log";
import { allowedOrigins, isSameOriginRequest } from "@/lib/same-origin";
import { attemptIdSchema } from "@/lib/validation/student-assessments";

/**
 * The best-effort submit when a one-sitting exam's page closes (W3a, D-W02,
 * D-W31). A closing page cannot reliably finish a Server Action, so the taking
 * page sends this with `navigator.sendBeacon`. It is the student's own submit of
 * their own attempt and nothing else: it finds the attempt only among the
 * signed-in person's profiles, does nothing to a default exam or homework, and
 * always answers 204 with no body. A lost signal costs nothing, because
 * `finaliseIfDue` catches the silence (D-W10). It is not a timer: nothing calls
 * it but that page.
 *
 * Under `/api` on purpose: the proxy's matcher skips it. Server Actions check the
 * origin themselves, and a route handler does not, so this one does (SEC-52).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ attemptId: string }> }) {
  const done = new NextResponse(null, { status: 204 });
  const origin = request.headers.get("origin");
  const allowed = allowedOrigins(request.headers, process.env.NEXT_PUBLIC_APP_URL, request.nextUrl.protocol);
  if (!isSameOriginRequest({ origin, secFetchSite: request.headers.get("sec-fetch-site") }, allowed)) return new NextResponse(null, { status: 403 });

  const parsed = attemptIdSchema.safeParse((await params).attemptId);
  if (!parsed.success) return done;
  const user = await getCurrentUser();
  if (!user) return done;

  try {
    for (const { student } of await studentBranches(user.id)) {
      const result = await submitAttempt(prisma, student, parsed.data, new Date(), { onlyOneSitting: true });
      if (result.ok || result.error === "notOneSitting") break;
    }
  } catch (error) {
    logBestEffort("one-sitting close")(error);
  }
  return done;
}
