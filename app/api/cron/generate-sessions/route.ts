import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/client";
import { ACCESSIBLE_LIFECYCLE_STATES } from "@/lib/db/platform";
import { generateSessions } from "@/lib/db/sessions";

/**
 * The rolling-window session generator's scheduled entry point
 * (docs/02-architecture.md §11): runs `generateSessions` for every center
 * that can currently sign in and operate (ONBOARDING/ACTIVE/GRACE, M19),
 * materializing the next ~6 weeks of `Session` rows from each center's
 * `ClassSchedule`s. Wired to Vercel Cron via `vercel.ts`.
 *
 * Vercel signs cron-triggered requests with `Authorization: Bearer
 * $CRON_SECRET` when the `CRON_SECRET` env var is set on the project — this
 * is the only check here, since the route does nothing scoped to a single
 * tenant's session and needs no `getTenantContext()`.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured." },
      { status: 500 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const centers = await prisma.center.findMany({
    where: { lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } },
    select: { id: true, settings: { select: { scheduleConflictPolicy: true } } },
  });

  const results = await Promise.all(
    centers.map(async (center) => {
      // Unattended: nobody can confirm a double-booking here (R3), so a
      // conflicting occurrence is always held back, under WARN as under
      // DENY; staff confirm it from a class's own "Generate sessions".
      const result = await generateSessions(
        prisma,
        center.id,
        center.settings?.scheduleConflictPolicy ?? "WARN",
        undefined,
        "en",
        { confirmConflicts: false, actorUserId: null },
      );
      return { centerId: center.id, ...result };
    }),
  );

  return NextResponse.json({
    centers: results.length,
    created: results.reduce((sum, row) => sum + row.created, 0),
    conflicts: results.reduce((sum, row) => sum + row.conflicts.length, 0),
  });
}
