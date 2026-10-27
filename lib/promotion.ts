/**
 * Bulk grade promotion — the pure rules (F4, docs/00 §4.1 item 4). No Prisma
 * and no `@/` imports, so `check:people` and `check:design` can run them.
 */

/** How long the latest batch can be undone, counted from when it ran. */
export const PROMOTION_UNDO_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant after which a batch can no longer be undone. */
export function undoDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + PROMOTION_UNDO_DAYS * DAY_MS);
}

/** Is a batch created at `createdAt` still inside its undo window at `now`? */
export function isWithinUndoWindow(createdAt: Date, now: Date): boolean {
  return now.getTime() <= undoDeadline(createdAt).getTime();
}

/** The most students one confirm may carry (a branch's whole grade, with room to spare). */
export const MAX_PROMOTION_STUDENTS = 5000;
