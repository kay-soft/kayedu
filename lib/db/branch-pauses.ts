import type { BranchPause, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — the gates exercise this module outside the
// Next.js runtime. It depends on nothing session-writing, so the session,
// attendance and approval writers can all ask it without an import cycle.
import { dateKey, dayMarker, zonedClock } from "../scheduling.ts";
import { centerTimeZone } from "./session-lifecycle.ts";

/**
 * Reading a branch's pause (U5, docs/00 §5.1 "Branch pause and delete"). A
 * pause is written only by a platform admin (`lib/db/branch-admin.ts`); this
 * is what every other part of the app asks of it. A pause ends by itself:
 * "current" is `startDate <= today <= endDate` in the branch's timezone, read
 * on every request — there is no cron and nothing flips at midnight.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The branch's today, as a "YYYY-MM-DD" key, in its own timezone. */
export async function branchTodayKey(db: Db, centerId: string, now: Date): Promise<string> {
  return zonedClock(now, await centerTimeZone(db, centerId)).dayKey;
}

/** A pause not ended early whose range is not over yet (`endDate >= today`). */
export function livePauseWhere(centerId: string, todayKey: string) {
  return {
    centerId,
    endedEarlyAt: null,
    endDate: { gte: dayMarker(todayKey) },
  } satisfies Prisma.BranchPauseWhereInput;
}

/** The branch's current or upcoming pause (at most one exists), or null. */
export async function liveBranchPause(db: Db, centerId: string, now: Date = new Date()): Promise<BranchPause | null> {
  const today = await branchTodayKey(db, centerId, now);
  return db.branchPause.findFirst({ where: livePauseWhere(centerId, today), orderBy: { startDate: "asc" } });
}

/** The pause covering the branch's today, or null — "Paused until <endDate>". */
export async function currentBranchPause(
  db: Db,
  centerId: string,
  now: Date = new Date(),
): Promise<BranchPause | null> {
  const today = await branchTodayKey(db, centerId, now);
  return db.branchPause.findFirst({
    where: { ...livePauseWhere(centerId, today), startDate: { lte: dayMarker(today) } },
  });
}

/**
 * Pure: of a branch's pauses (already narrowed to ones not ended early), the
 * end date of the one covering `todayKey`, or null. For a read that loads the
 * pauses through its own centre select — the public Explore module may read
 * only `center`, `classGroup`, `membership` and the catalog (`check:public`).
 */
export function pausedUntilFrom(
  pauses: readonly { startDate: Date; endDate: Date }[],
  todayKey: string,
): Date | null {
  const covering = pauses.find((pause) => dateKey(pause.startDate) <= todayKey && dateKey(pause.endDate) >= todayKey);
  return covering ? covering.endDate : null;
}

export type BranchPauseRefusal = "branchPaused";

/**
 * The one refusal every pause-sensitive write asks (U5): while a pause covers
 * the branch's today (`whilePausedToday` — check-in, extra and one-time
 * sessions), or when `date` — a session being created, moved or requested —
 * falls inside a current or upcoming pause. `null` when the write may go on.
 */
export async function branchPauseRefusal(
  db: Db,
  centerId: string,
  options: { date?: Date; whilePausedToday?: boolean; now?: Date },
): Promise<BranchPauseRefusal | null> {
  const now = options.now ?? new Date();
  const today = await branchTodayKey(db, centerId, now);
  const pauses = await db.branchPause.findMany({
    where: livePauseWhere(centerId, today),
    select: { startDate: true, endDate: true },
  });
  if (pauses.length === 0) return null;
  if (options.whilePausedToday && pausedUntilFrom(pauses, today)) return "branchPaused";
  if (options.date) {
    const key = dateKey(options.date);
    if (pauses.some((pause) => dateKey(pause.startDate) <= key && dateKey(pause.endDate) >= key)) {
      return "branchPaused";
    }
  }
  return null;
}
