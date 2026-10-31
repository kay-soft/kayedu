import type { BranchPause, Center, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:branches` and `check:admin`
// exercise this module directly, outside the Next.js runtime (same reasoning
// as lib/db/platform.ts). The client is injected.
import {
  addDays,
  dateKey,
  dayMarker,
  findSessionConflicts,
  zonedClock,
  type ExistingSession,
} from "../scheduling.ts";
import { effectiveRoomIds } from "../rooms.ts";
import { MAX_PAUSE_DAYS, RESTORE_WINDOW_DAYS } from "../branch-setup.ts";
import { writeAuditRow } from "./audit-row.ts";
import { lockOrganizationBranches } from "./platform.ts";
import { branchTodayKey as branchToday, livePauseWhere } from "./branch-pauses.ts";
import { centerTimeZone, WRITE_TRANSACTION_OPTIONS } from "./session-lifecycle.ts";
import { cancelSession, deriveSessionDisplayStatus } from "./sessions.ts";
import { loadSessionOccupancy } from "./slot-conflicts.ts";

/**
 * Branch management by a platform admin (U5, docs/00 §5.1 "Branch pause and
 * delete"; decided 29 Oct with Kamal — OD-12 re-decided). **No centre role
 * reaches anything here**: there is no centre action that calls it, and every
 * caller has run `requirePlatformAdmin()` first (the same contract as
 * `lib/db/platform.ts`). Every write is one transaction with its
 * `platform.branch.*` audit row (ids, dates and counts only — D-20).
 *
 * - **Edit** — the names and the theme colour. The slug (the public URL) and
 *   the timezone never change here.
 * - **Pause** — a date range (start ≥ the branch's today, end ≥ start, at most
 *   90 days, one current-or-future pause per branch). Creating it cancels every
 *   SCHEDULED, not-yet-started session of the branch dated in the range through
 *   `cancelSession` (so F6's bookings go with it) and tags each with
 *   `Session.pauseId`. Started, live and closed sessions are never touched; nor
 *   are enrolments. It ends by itself after `endDate` (no cron), or early:
 *   "End pause now" restores, under the conflict policy, each tagged session
 *   still in the future and untouched since; what now clashes stays cancelled.
 * - **Delete** — soft: `deletedAt`/`deletedBy`/`restorableUntil` (30 days).
 *   Refused for the organization's only branch, while a session there is live,
 *   and while a settlement there is DRAFT or APPROVED. Restore until
 *   `restorableUntil`, within the branch limit.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A pause covering a whole quarter cancels hundreds of sessions, each through
 * `cancelSession`'s own locks — more than the default 20s budget allows over a
 * pooled connection. The longer timeout is this transaction's alone.
 */
const PAUSE_TRANSACTION_OPTIONS = { maxWait: WRITE_TRANSACTION_OPTIONS.maxWait, timeout: 120_000 } as const;

async function inLongTransaction<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ("$transaction" in db) return (db as PrismaClient).$transaction(fn, PAUSE_TRANSACTION_OPTIONS);
  return fn(db);
}

/** Locks the branch's own row — what serializes two pauses of one branch. */
async function lockCenter(tx: Prisma.TransactionClient, centerId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Center" WHERE "id" = ${centerId} FOR UPDATE`;
  return rows.length === 1;
}

// ── Edit ───────────────────────────────────────────────────────────────────

export type BranchEditInput = {
  centerId: string;
  name: string;
  nameEn: string | null;
  themeColor: string;
  actorUserId: string;
};

export type BranchEditResult = { ok: true; center: Center } | { ok: false; error: "notFound" };

/** Names and theme colour only — never the slug (the public URL) or the timezone. */
export async function updateBranchDetails(db: PrismaClient, input: BranchEditInput): Promise<BranchEditResult> {
  return db.$transaction(async (tx): Promise<BranchEditResult> => {
    if (!(await lockCenter(tx, input.centerId))) return { ok: false, error: "notFound" };
    const before = await tx.center.findUnique({ where: { id: input.centerId } });
    if (!before || before.deletedAt) return { ok: false, error: "notFound" };
    const center = await tx.center.update({
      where: { id: input.centerId },
      data: { name: input.name, nameEn: input.nameEn, themeColor: input.themeColor },
    });
    // D-20: which fields changed, never the typed names themselves.
    const changed = [
      before.name !== center.name ? "nameAr" : null,
      before.nameEn !== center.nameEn ? "nameEn" : null,
      before.themeColor !== center.themeColor ? "themeColor" : null,
    ].filter((field): field is string => field !== null);
    await writeAuditRow(tx, {
      centerId: center.id,
      actorUserId: input.actorUserId,
      action: "platform.branch.update",
      entityType: "Center",
      entityId: center.id,
      after: { changed },
    });
    return { ok: true, center };
  }, WRITE_TRANSACTION_OPTIONS);
}

// ── Pause ──────────────────────────────────────────────────────────────────

export type PauseRangeError = "pauseStartPast" | "pauseEndBeforeStart" | "pauseTooLong";

/** Pure: the range rule, on "YYYY-MM-DD" keys (inclusive). */
export function pauseRangeError(startKey: string, endKey: string, todayKey: string): PauseRangeError | null {
  if (startKey < todayKey) return "pauseStartPast";
  if (endKey < startKey) return "pauseEndBeforeStart";
  const days = Math.round((dayMarker(endKey).getTime() - dayMarker(startKey).getTime()) / DAY_MS) + 1;
  if (days > MAX_PAUSE_DAYS) return "pauseTooLong";
  return null;
}

export type BranchPauseInput = {
  centerId: string;
  /** "YYYY-MM-DD", the branch's own calendar. */
  startDate: string;
  endDate: string;
  reason: string | null;
  actorUserId: string;
};

export type PauseImpact = {
  /** Scheduled, not-yet-started sessions the pause cancels. */
  sessions: number;
  /** Distinct classes they belong to (one-time sessions belong to none). */
  classes: number;
  /** Open single-session bookings cancelled with them (F6). */
  bookings: number;
  /** Sessions in the range kept because they hold a payment (`cancelSession`'s `hasPayments`). */
  keptWithPayments: number;
};

export type PausePreviewResult =
  | { ok: true; impact: PauseImpact }
  | { ok: false; error: "notFound" | "pauseExists" | PauseRangeError };

export type PauseCreateResult =
  | { ok: true; pause: BranchPause; impact: PauseImpact }
  | { ok: false; error: "notFound" | "pauseExists" | PauseRangeError };

/**
 * The sessions a pause over [start, end] would cancel: SCHEDULED, not closed,
 * not rescheduled away, dated in the range, and — in the session's own frozen
 * timezone — not started yet (a session already live today is left alone).
 */
async function pauseCandidates(db: Db, centerId: string, startKey: string, endKey: string, now: Date) {
  const timeZone = await centerTimeZone(db, centerId);
  const rows = await db.session.findMany({
    where: {
      centerId,
      status: "SCHEDULED",
      closedAt: null,
      rescheduledToId: null,
      date: { gte: dayMarker(startKey), lte: dayMarker(endKey) },
    },
    select: {
      id: true,
      classGroupId: true,
      status: true,
      date: true,
      startTime: true,
      endTime: true,
      rescheduledToId: true,
      closedAt: true,
      timezone: true,
      _count: { select: { payments: { where: { voided: false, refunded: false } } } },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  return rows.filter((row) => deriveSessionDisplayStatus(row, now, timeZone) === "SCHEDULED");
}

async function pauseImpact(
  db: Db,
  centerId: string,
  candidates: Awaited<ReturnType<typeof pauseCandidates>>,
): Promise<PauseImpact> {
  const cancellable = candidates.filter((row) => row._count.payments === 0);
  const bookings =
    cancellable.length === 0
      ? 0
      : await db.sessionBooking.count({
          where: {
            centerId,
            sessionId: { in: cancellable.map((row) => row.id) },
            status: { in: ["PENDING", "CONFIRMED"] },
            sessionAttendeeId: null,
          },
        });
  return {
    sessions: cancellable.length,
    classes: new Set(cancellable.map((row) => row.classGroupId).filter((id): id is string => id !== null)).size,
    bookings,
    keptWithPayments: candidates.length - cancellable.length,
  };
}

async function pauseRefusal(
  db: Db,
  input: Pick<BranchPauseInput, "centerId" | "startDate" | "endDate">,
  now: Date,
): Promise<"notFound" | "pauseExists" | PauseRangeError | null> {
  const center = await db.center.findUnique({ where: { id: input.centerId }, select: { deletedAt: true } });
  if (!center || center.deletedAt) return "notFound";
  const today = await branchToday(db, input.centerId, now);
  const rangeError = pauseRangeError(input.startDate, input.endDate, today);
  if (rangeError) return rangeError;
  const live = await db.branchPause.count({ where: livePauseWhere(input.centerId, today) });
  return live > 0 ? "pauseExists" : null;
}

/** What a pause would do — read only, nothing written (the confirmation's numbers). */
export async function previewBranchPause(
  db: Db,
  input: Pick<BranchPauseInput, "centerId" | "startDate" | "endDate">,
  now: Date = new Date(),
): Promise<PausePreviewResult> {
  const refusal = await pauseRefusal(db, input, now);
  if (refusal) return { ok: false, error: refusal };
  const candidates = await pauseCandidates(db, input.centerId, input.startDate, input.endDate, now);
  return { ok: true, impact: await pauseImpact(db, input.centerId, candidates) };
}

/**
 * Creates the pause and cancels its sessions, in **one transaction** under the
 * branch's row lock (so two pauses of one branch serialize, and the second sees
 * the first). Each session goes through `cancelSession` — its own closure guard,
 * its `hasPayments` refusal and F6's booking cancellation — tagged with the
 * pause and stamped with the pause's `createdAt` as its `updatedAt`, which is
 * how "untouched since" is told later.
 */
export async function createBranchPause(
  db: PrismaClient,
  input: BranchPauseInput,
  now: Date = new Date(),
): Promise<PauseCreateResult> {
  return inLongTransaction(db, async (tx): Promise<PauseCreateResult> => {
    if (!(await lockCenter(tx, input.centerId))) return { ok: false, error: "notFound" };
    const refusal = await pauseRefusal(tx, input, now);
    if (refusal) return { ok: false, error: refusal };

    const pause = await tx.branchPause.create({
      data: {
        centerId: input.centerId,
        startDate: dayMarker(input.startDate),
        endDate: dayMarker(input.endDate),
        reason: input.reason,
        createdBy: input.actorUserId,
        createdAt: now,
      },
    });

    const candidates = await pauseCandidates(tx, input.centerId, input.startDate, input.endDate, now);
    let sessions = 0;
    let keptWithPayments = 0;
    let bookings = 0;
    const classes = new Set<string>();
    for (const candidate of candidates) {
      const result = await cancelSession(tx, input.centerId, candidate.id, {
        now,
        pause: { id: pause.id, stampedAt: pause.createdAt },
      });
      if (result.ok) {
        sessions += 1;
        bookings += result.bookingsCancelled;
        if (candidate.classGroupId) classes.add(candidate.classGroupId);
      } else if (result.error === "hasPayments") {
        keptWithPayments += 1;
      }
    }
    const impact: PauseImpact = { sessions, classes: classes.size, bookings, keptWithPayments };

    // The reason is on the pause itself (D-20 keeps typed text out of the log).
    await writeAuditRow(tx, {
      centerId: input.centerId,
      actorUserId: input.actorUserId,
      action: "platform.branch.pause",
      entityType: "BranchPause",
      entityId: pause.id,
      after: { startDate: input.startDate, endDate: input.endDate, ...impact },
    });
    return { ok: true, pause, impact };
  });
}

export type PauseEndResult =
  | {
      ok: true;
      /** Sessions brought back to SCHEDULED. */
      restored: number;
      /** Tagged sessions that now clash (room or teacher) — they stay cancelled. */
      keptConflicts: number;
      /** Tagged sessions changed since the pause, started, on a holiday or of a deactivated class. */
      keptOther: number;
    }
  | { ok: false; error: "notFound" | "pauseOver" };

/**
 * "End pause now" (admin): the pause ends today — `endedEarlyAt` — and every
 * session it cancelled that is **still in the future and untouched since**
 * (still CANCELLED with this pause's tag, `updatedAt` no later than the pause's
 * own stamp, not rescheduled, not closed, its class still active, its date not
 * a holiday) is restored to SCHEDULED, one at a time against the branch's
 * current occupancy. Anything that would now double-book a room or a teacher
 * stays cancelled and is counted, whatever the conflict policy says — there is
 * no "I understand" here (R3: WARN without confirmation refuses too).
 * Bookings are **not** restored (the dialog says so).
 */
export async function endBranchPause(
  db: PrismaClient,
  input: { centerId: string; pauseId: string; actorUserId: string },
  now: Date = new Date(),
): Promise<PauseEndResult> {
  return inLongTransaction(db, async (tx): Promise<PauseEndResult> => {
    if (!(await lockCenter(tx, input.centerId))) return { ok: false, error: "notFound" };
    const pause = await tx.branchPause.findFirst({ where: { id: input.pauseId, centerId: input.centerId } });
    if (!pause) return { ok: false, error: "notFound" };
    const timeZone = await centerTimeZone(tx, input.centerId);
    const today = zonedClock(now, timeZone).dayKey;
    if (pause.endedEarlyAt || dateKey(pause.endDate) < today) return { ok: false, error: "pauseOver" };

    await tx.branchPause.update({
      where: { id: pause.id },
      data: { endedEarlyAt: now, endedEarlyBy: input.actorUserId },
    });

    const tagged = await tx.session.findMany({
      where: { centerId: input.centerId, pauseId: pause.id },
      select: {
        id: true,
        classGroupId: true,
        teacherId: true,
        roomId: true,
        status: true,
        date: true,
        startTime: true,
        endTime: true,
        rescheduledToId: true,
        closedAt: true,
        timezone: true,
        updatedAt: true,
        extraRooms: { select: { roomId: true } },
        classGroup: { select: { active: true } },
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
    });
    const holidays = new Set(
      (
        await tx.holiday.findMany({
          where: { centerId: input.centerId, date: { gte: pause.startDate, lte: pause.endDate } },
          select: { date: true },
        })
      ).map((holiday) => dateKey(holiday.date)),
    );

    const restorable = tagged.filter(
      (row) =>
        row.status === "CANCELLED" &&
        row.rescheduledToId === null &&
        row.closedAt === null &&
        row.updatedAt.getTime() <= pause.createdAt.getTime() &&
        (row.classGroupId === null || row.classGroup?.active === true) &&
        !holidays.has(dateKey(row.date)) &&
        deriveSessionDisplayStatus({ ...row, status: "SCHEDULED" }, now, timeZone) === "SCHEDULED",
    );

    // The branch's occupancy over the range, grown as each session comes back,
    // so two restored sessions are checked against each other too.
    const occupancy: ExistingSession[] =
      restorable.length === 0
        ? []
        : await loadSessionOccupancy(tx, input.centerId, "en", restorable[0].date, restorable[restorable.length - 1].date);

    let restored = 0;
    let keptConflicts = 0;
    for (const row of restorable) {
      const roomIds = effectiveRoomIds(row.roomId, row.extraRooms.map((extra) => extra.roomId));
      const conflicts = findSessionConflicts(
        {
          classGroupId: row.classGroupId,
          excludeSessionId: row.id,
          teacherId: row.teacherId,
          roomId: row.roomId,
          roomIds,
          date: row.date,
          startTime: row.startTime,
          endTime: row.endTime,
        },
        occupancy,
      );
      if (conflicts.length > 0) {
        keptConflicts += 1;
        continue;
      }
      // Re-asserted in the write: still this pause's, still cancelled, still untouched.
      const updated = await tx.session.updateMany({
        where: {
          id: row.id,
          centerId: input.centerId,
          pauseId: pause.id,
          status: "CANCELLED",
          updatedAt: { lte: pause.createdAt },
        },
        data: { status: "SCHEDULED", pauseId: null },
      });
      if (updated.count === 0) continue;
      restored += 1;
      occupancy.push({
        sessionId: row.id,
        classGroupId: row.classGroupId,
        teacherId: row.teacherId,
        roomId: row.roomId,
        roomIds,
        date: row.date,
        startTime: row.startTime,
        endTime: row.endTime,
        className: "",
      });
    }
    const keptOther = tagged.length - restored - keptConflicts;

    await writeAuditRow(tx, {
      centerId: input.centerId,
      actorUserId: input.actorUserId,
      action: "platform.branch.pause.end",
      entityType: "BranchPause",
      entityId: pause.id,
      after: { endedOn: today, restored, keptConflicts, keptOther },
    });
    return { ok: true, restored, keptConflicts, keptOther };
  });
}

// ── Delete / restore ───────────────────────────────────────────────────────

export type BranchDeleteError =
  | "notFound"
  | "nameMismatch"
  | "onlyBranch"
  | "liveSession"
  | "openSettlement";

export type BranchDeleteResult = { ok: true; center: Center } | { ok: false; error: BranchDeleteError };

/** A session of the branch that is live right now — started, not closed, not cancelled or moved. */
async function hasLiveSession(db: Db, centerId: string, now: Date): Promise<boolean> {
  const timeZone = await centerTimeZone(db, centerId);
  const today = dayMarker(zonedClock(now, timeZone).dayKey);
  const rows = await db.session.findMany({
    where: {
      centerId,
      status: { not: "CANCELLED" },
      closedAt: null,
      rescheduledToId: null,
      // A frozen timezone may put "today" a day either side of the branch's.
      date: { gte: addDays(today, -1), lte: addDays(today, 1) },
    },
    select: { status: true, date: true, startTime: true, endTime: true, rescheduledToId: true, closedAt: true, timezone: true },
  });
  return rows.some((row) => deriveSessionDisplayStatus(row, now, timeZone) === "LIVE");
}

/**
 * Why this branch may not be deleted right now, or null. Read inside the
 * delete's transaction (organization row locked) and by the page, so the
 * dialog can say it up front; the transaction's answer is the one that counts.
 */
export async function branchDeleteBlocker(
  db: Db,
  center: Pick<Center, "id" | "organizationId">,
  now: Date = new Date(),
): Promise<Exclude<BranchDeleteError, "notFound" | "nameMismatch"> | null> {
  const siblings = await db.center.count({ where: { organizationId: center.organizationId, deletedAt: null } });
  if (siblings <= 1) return "onlyBranch";
  if (await hasLiveSession(db, center.id, now)) return "liveSession";
  const openSettlements = await db.settlement.count({
    where: { centerId: center.id, status: { in: ["DRAFT", "APPROVED"] } },
  });
  return openSettlements > 0 ? "openSettlement" : null;
}

/**
 * Soft-deletes a branch. The admin typed its name (`confirmName`, compared
 * trimmed, exactly). Locks the organization row as F1's add does, so a delete
 * and an add or restore of the same organization serialize, and two deletes
 * can never leave it with no branch.
 */
export async function deleteBranch(
  db: PrismaClient,
  input: { centerId: string; confirmName: string; actorUserId: string },
  now: Date = new Date(),
): Promise<BranchDeleteResult> {
  const peek = await db.center.findUnique({ where: { id: input.centerId }, select: { organizationId: true } });
  if (!peek) return { ok: false, error: "notFound" };
  return db.$transaction(async (tx): Promise<BranchDeleteResult> => {
    const lock = await lockOrganizationBranches(tx, peek.organizationId);
    if (!lock) return { ok: false, error: "notFound" };
    const center = await tx.center.findUnique({ where: { id: input.centerId } });
    if (!center || center.deletedAt || center.organizationId !== peek.organizationId) {
      return { ok: false, error: "notFound" };
    }
    if (input.confirmName.trim() !== center.name.trim()) return { ok: false, error: "nameMismatch" };
    const blocker = await branchDeleteBlocker(tx, center, now);
    if (blocker) return { ok: false, error: blocker };

    const restorableUntil = new Date(now.getTime() + RESTORE_WINDOW_DAYS * DAY_MS);
    const updated = await tx.center.update({
      where: { id: center.id },
      data: { deletedAt: now, deletedBy: input.actorUserId, restorableUntil },
    });
    await writeAuditRow(tx, {
      centerId: center.id,
      actorUserId: input.actorUserId,
      action: "platform.branch.delete",
      entityType: "Center",
      entityId: center.id,
      after: {
        organizationId: center.organizationId,
        lifecycleState: center.lifecycleState,
        restorableUntil: restorableUntil.toISOString(),
      },
    });
    return { ok: true, center: updated };
  }, WRITE_TRANSACTION_OPTIONS);
}

export type BranchRestoreResult =
  | { ok: true; center: Center }
  | { ok: false; error: "notFound" | "notDeleted" | "restoreExpired" | "branchLimitReached" };

/**
 * Restores a deleted branch until its `restorableUntil`. Refused when the
 * organization's branch limit is full and the branch would count (an ARCHIVED
 * branch never counts, so it needs no slot). After the window the row is still
 * in the database — restorable only by a manual fix — until purge exists.
 */
export async function restoreBranch(
  db: PrismaClient,
  input: { centerId: string; actorUserId: string },
  now: Date = new Date(),
): Promise<BranchRestoreResult> {
  const peek = await db.center.findUnique({ where: { id: input.centerId }, select: { organizationId: true } });
  if (!peek) return { ok: false, error: "notFound" };
  return db.$transaction(async (tx): Promise<BranchRestoreResult> => {
    const lock = await lockOrganizationBranches(tx, peek.organizationId);
    if (!lock) return { ok: false, error: "notFound" };
    const center = await tx.center.findUnique({ where: { id: input.centerId } });
    if (!center || center.organizationId !== peek.organizationId) return { ok: false, error: "notFound" };
    if (!center.deletedAt) return { ok: false, error: "notDeleted" };
    if (!center.restorableUntil || center.restorableUntil.getTime() < now.getTime()) {
      return { ok: false, error: "restoreExpired" };
    }
    if (center.lifecycleState !== "ARCHIVED" && lock.used >= lock.maxBranches) {
      return { ok: false, error: "branchLimitReached" };
    }
    const updated = await tx.center.update({
      where: { id: center.id },
      data: { deletedAt: null, deletedBy: null, restorableUntil: null },
    });
    await writeAuditRow(tx, {
      centerId: center.id,
      actorUserId: input.actorUserId,
      action: "platform.branch.restore",
      entityType: "Center",
      entityId: center.id,
      after: { organizationId: center.organizationId, deletedAt: center.deletedAt.toISOString() },
    });
    return { ok: true, center: updated };
  }, WRITE_TRANSACTION_OPTIONS);
}

/** An organization's deleted branches, newest first — its admin page's "Deleted branches". */
export function platformDeletedBranches(db: Db, organizationId: string) {
  return db.center.findMany({
    where: { organizationId, deletedAt: { not: null } },
    select: {
      id: true,
      name: true,
      nameEn: true,
      slug: true,
      themeColor: true,
      lifecycleState: true,
      deletedAt: true,
      restorableUntil: true,
    },
    orderBy: { deletedAt: "desc" },
  });
}
