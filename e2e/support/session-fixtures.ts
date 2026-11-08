import type { PrismaClient } from "@prisma/client";

import { assertSafeToWrite } from "../../scripts/lib/env";

import { ACCOUNTS, SEED } from "./accounts";

/**
 * A one-time session (no class) the e2e suite inserts straight into the database
 * (V9): the seed gives teacher.downtown none, and the page that must render it is
 * the point of the test. Staging-guarded (S1). The title starts with the test's own
 * tag (the shared e2e prefix), so `removeE2eOneOffSessions(db, tag)`
 * (`scripts/lib/e2e-sessions.ts`) removes exactly this row and a second run leaves
 * the same row counts.
 *
 * It has the one-time shape (`oneOffSessionShapeError`, lib/db/sessions.ts): a
 * title, its teacher, a price and both halves of its own cut. Price and cut are 0:
 * no payment is ever recorded against it.
 */
export async function insertOneOffSession(db: PrismaClient, tag: string): Promise<{ id: string; title: string }> {
  assertSafeToWrite("the e2e session fixtures");
  const membership = await db.membership.findFirst({
    where: {
      role: "TEACHER",
      active: true,
      user: { email: ACCOUNTS.teacherDowntown.email },
      center: { kind: "BRANCH", name: SEED.downtown },
    },
    select: { centerId: true, userId: true },
  });
  if (!membership) throw new Error("e2e: teacher.downtown has no active TEACHER membership at Downtown");
  const room = await db.room.findFirst({ where: { centerId: membership.centerId }, orderBy: { name: "asc" }, select: { id: true } });
  // A week ahead, at midnight UTC (a session's calendar day): never closed, never
  // outside the visibility window.
  const today = new Date();
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 7));
  const title = `${tag}-one-off`;
  const session = await db.session.create({
    data: {
      centerId: membership.centerId,
      classGroupId: null,
      title,
      isManual: true,
      teacherId: membership.userId,
      roomId: room?.id ?? null,
      date,
      startTime: "07:00",
      endTime: "08:00",
      priceSnapshot: 0,
      centerShareType: "PERCENTAGE",
      centerShareValue: 0,
    },
    select: { id: true },
  });
  return { id: session.id, title };
}
