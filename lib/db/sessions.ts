import type {
  ConflictPolicy,
  Prisma,
  PrismaClient,
  Session,
  SessionStatus,
  ShareType,
} from "@prisma/client";

// Relative imports on purpose: `npm run check:classes` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/students.ts
// and lib/db/tenant-scope.ts). The Prisma client is *injected* rather than
// imported from lib/db/client.ts for the same reason — the gate script
// constructs its own `PrismaClient()`, the app passes the shared singleton.
import { scopedData, scopedWhere } from "./tenant-scope.ts";
import {
  catalogLabel,
  catalogLabelWithSelection,
  type CatalogWithSelection,
} from "../catalog.ts";
import {
  GENERATION_WINDOW_DAYS,
  addDays,
  dateKey,
  decideConflicts,
  findSessionConflicts,
  generateOccurrenceDates,
  parseTimeToMinutes,
  startOfUtcDay,
  zonedClock,
  type ScheduleConflict,
} from "../scheduling.ts";
import { effectiveRoomIds } from "../rooms.ts";
import {
  ensureSessionOpenOrAutoClose,
  runInTransaction,
} from "./session-lifecycle.ts";
import { resolveRoomSet, writeSessionExtraRooms, type RoomSetError } from "./room-sets.ts";
import { loadSessionOccupancy, writeConfirmedConflictAudit } from "./slot-conflicts.ts";

/**
 * The session generator (docs/02-architecture.md §11, spec §5 "Scheduling"):
 * materializes `Session` rows from `ClassSchedule` on a rolling window,
 * snapshotting the class price, skipping the holiday calendar, and detecting
 * teacher/room conflicts against every other class in the center.
 *
 * Regeneration is idempotent: `Session` is unique on
 * `(classGroupId, date, startTime)`, so a `createMany({ skipDuplicates: true })`
 * against that key never duplicates a session a previous run already created —
 * running this twice in a row creates zero new rows the second time. An
 * occurrence that already exists is not re-checked for conflicts either, so
 * a double-booking confirmed on an earlier run never asks again.
 *
 * R3: a generated session inherits its class's whole **room set** — the
 * primary `roomId` plus a `SessionRoom` row per extra room — and the conflict
 * check treats every room of either side's set as busy.
 */

/**
 * The R3 confirmation contract, as every slot-writing function here takes it.
 * `confirmConflicts` is what the person ticked ("I understand, create
 * anyway"); every Server Action passes it explicitly (`npm run check:rooms`
 * asserts that statically). **Omitted** means a pre-R3 script caller (the
 * seed, the older gates): conflicts then follow the policy alone, exactly as
 * before R3 — WARN saves, DENY refuses — and no confirmation audit is
 * written. `actorUserId` attributes the confirmation's audit row.
 */
export type ConflictConfirmation = {
  confirmConflicts?: boolean;
  actorUserId?: string | null;
};

export type GenerationConflict = ScheduleConflict & { date: string };

export type GenerateSessionsResult = {
  created: number;
  conflicts: GenerationConflict[];
  /**
   * R3 — under WARN, conflicting occurrences were held back because the
   * double-booking was not confirmed (non-conflicting ones were still
   * created). Re-running with `confirmConflicts: true` creates them.
   */
  needsConfirmation: boolean;
};

type ClassForGeneration = {
  id: string;
  teacherId: string;
  roomId: string | null;
  extraRoomIds: string[];
  price: number;
  schedules: { dayOfWeek: number; startTime: string; endTime: string }[];
  className: string;
};

/** The class fields the generator needs, loaded once per run. */
async function loadClassesForGeneration(
  db: PrismaClient,
  centerId: string,
  locale: string,
  classGroupId?: string,
): Promise<ClassForGeneration[]> {
  const rows = await db.classGroup.findMany({
    where: scopedWhere(centerId, {
      active: true,
      ...(classGroupId ? { id: classGroupId } : {}),
    }),
    select: {
      id: true,
      teacherId: true,
      roomId: true,
      extraRooms: { select: { roomId: true } },
      price: true,
      schedules: {
        select: { dayOfWeek: true, startTime: true, endTime: true },
      },
      subject: { select: { nameAr: true, nameEn: true } },
      grade: { select: { nameAr: true, nameEn: true } },
    },
  });

  return rows
    .filter((row) => row.schedules.length > 0)
    .map((row) => ({
      id: row.id,
      teacherId: row.teacherId,
      roomId: row.roomId,
      extraRoomIds: row.roomId ? row.extraRooms.map((extra) => extra.roomId) : [],
      price: row.price,
      schedules: row.schedules,
      className:
        [
          row.subject ? catalogLabel(locale, row.subject) : null,
          row.grade ? catalogLabel(locale, row.grade) : null,
        ]
          .filter(Boolean)
          .join(" · ") || "—",
    }));
}

async function loadHolidayKeys(
  db: PrismaClient,
  centerId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<Set<string>> {
  const rows = await db.holiday.findMany({
    where: scopedWhere(centerId, { date: { gte: windowStart, lte: windowEnd } }),
    select: { date: true },
  });
  return new Set(rows.map((row) => row.date.toISOString().slice(0, 10)));
}

/** `(classGroupId, date, startTime)` — the generator's idempotency key. */
function occurrenceKey(classGroupId: string, date: Date, startTime: string): string {
  return `${classGroupId}|${dateKey(date)}|${startTime}`;
}

/**
 * Generates sessions for one class (or, when `classGroupId` is omitted, every
 * active class in the center) across the rolling window starting today.
 * A conflicting occurrence is skipped under `DENY`; under `WARN` it is
 * created only when the double-booking is confirmed (`confirmConflicts`,
 * audited) and otherwise held back with `needsConfirmation` — either way,
 * the caller gets back what happened so the UI can show it.
 */
export async function generateSessions(
  db: PrismaClient,
  centerId: string,
  conflictPolicy: ConflictPolicy,
  classGroupId?: string,
  // Only used to label a conflict for display (`GenerationConflict.className`)
  // — the cron-triggered path (`app/api/cron/generate-sessions/route.ts`) has
  // no user/locale to thread through, so it stays on this neutral default.
  locale = "en",
  options: ConflictConfirmation = {},
): Promise<GenerateSessionsResult> {
  const windowStart = startOfUtcDay(new Date());
  // generateOccurrenceDates treats both ends inclusively (its own doc-comment
  // contract, `lib/scheduling.ts`), so a window of GENERATION_WINDOW_DAYS
  // calendar days is [windowStart, windowStart + (GENERATION_WINDOW_DAYS - 1)]
  // — 42 distinct days, not 43. Off-by-one here previously made the window
  // inclusive of a 43rd day, which silently added a bonus 7th occurrence of
  // whichever weekday happened to equal "today"'s weekday on the day the
  // generator ran — a date-dependent bug, not just a date-dependent test.
  const windowEnd = addDays(windowStart, GENERATION_WINDOW_DAYS - 1);

  const [classes, holidayKeys, existing] = await Promise.all([
    loadClassesForGeneration(db, centerId, locale, classGroupId),
    loadHolidayKeys(db, centerId, windowStart, windowEnd),
    loadSessionOccupancy(db, centerId, locale, windowStart, windowEnd),
  ]);

  // Occurrences this run's classes already have (any status) — never
  // re-inserted, never re-checked.
  const existingKeys = new Set(
    (
      await db.session.findMany({
        where: scopedWhere(centerId, {
          classGroupId: { in: classes.map((row) => row.id) },
          date: { gte: windowStart, lte: windowEnd },
        }),
        select: { classGroupId: true, date: true, startTime: true },
      })
    ).map((row) => occurrenceKey(row.classGroupId, row.date, row.startTime)),
  );

  // A pre-R3 caller that passes no flag keeps the policy-only behaviour.
  const confirm = options.confirmConflicts ?? true;

  // Accumulates as we go, so two classes generated in the same run still see
  // each other's freshly-created occurrences when checking for conflicts.
  const known = [...existing];
  const conflicts: GenerationConflict[] = [];
  const confirmed: GenerationConflict[] = [];
  let needsConfirmation = false;
  const toInsert: {
    classGroupId: string;
    teacherId: string;
    roomId: string | null;
    date: Date;
    startTime: string;
    endTime: string;
    priceSnapshot: number;
  }[] = [];
  const extrasByKey = new Map<string, string[]>();

  for (const classGroup of classes) {
    const roomIds = effectiveRoomIds(classGroup.roomId, classGroup.extraRoomIds);
    for (const schedule of classGroup.schedules) {
      const dates = generateOccurrenceDates(
        schedule,
        windowStart,
        windowEnd,
        holidayKeys,
      );

      for (const date of dates) {
        const key = occurrenceKey(classGroup.id, date, schedule.startTime);
        if (existingKeys.has(key)) continue;

        const candidate = {
          classGroupId: classGroup.id,
          teacherId: classGroup.teacherId,
          roomId: classGroup.roomId,
          roomIds,
          date,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
        };

        const found = findSessionConflicts(candidate, known).map((conflict) => ({
          ...conflict,
          date: dateKey(date),
        }));
        conflicts.push(...found);
        const decision = decideConflicts(found.length, conflictPolicy, confirm);
        if (decision === "denied") continue;
        if (decision === "needsConfirmation") {
          needsConfirmation = true;
          continue;
        }
        if (found.length > 0) confirmed.push(...found);

        existingKeys.add(key);
        toInsert.push({
          classGroupId: classGroup.id,
          teacherId: classGroup.teacherId,
          roomId: classGroup.roomId,
          date,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          priceSnapshot: classGroup.price,
        });
        if (classGroup.extraRoomIds.length > 0) {
          extrasByKey.set(key, classGroup.extraRoomIds);
        }
        known.push({ ...candidate, className: classGroup.className });
      }
    }
  }

  if (toInsert.length === 0) return { created: 0, conflicts, needsConfirmation };

  const result = await db.$transaction(async (tx) => {
    const inserted = await tx.session.createMany({
      data: toInsert.map((row) => scopedData(centerId, row)),
      skipDuplicates: true,
    });

    // Copy each class's extra rooms onto the sessions just created (R3).
    if (extrasByKey.size > 0) {
      const created = await tx.session.findMany({
        where: scopedWhere(centerId, {
          classGroupId: { in: [...new Set(toInsert.map((row) => row.classGroupId))] },
          date: { gte: windowStart, lte: windowEnd },
        }),
        select: { id: true, classGroupId: true, date: true, startTime: true },
      });
      const rows = created.flatMap((session) =>
        (extrasByKey.get(occurrenceKey(session.classGroupId, session.date, session.startTime)) ?? []).map(
          (roomId) => scopedData(centerId, { sessionId: session.id, roomId }),
        ),
      );
      if (rows.length > 0) {
        await tx.sessionRoom.createMany({ data: rows, skipDuplicates: true });
      }
    }

    if (options.confirmConflicts === true && confirmed.length > 0) {
      await writeConfirmedConflictAudit(tx, {
        centerId,
        actorUserId: options.actorUserId ?? null,
        entityType: classGroupId ? "ClassGroup" : "Center",
        entityId: classGroupId ?? centerId,
        context: "session.generate",
        conflicts: confirmed,
      });
    }
    return inserted;
  });

  return { created: result.count, conflicts, needsConfirmation };
}

// ─────────────────────────────────────────────────────────────────────────
// Session lifecycle: cancel / reschedule (M10, spec §7 acceptance criterion
// 11, closing the gap flagged since M5/docs §11: "Cancel/reschedule/edit of
// an individual session is not yet built"). Kept in this file beside the
// generator, for the same "no @/ imports" reason the rest of this module is
// written that way (docs/02 §5).
// ─────────────────────────────────────────────────────────────────────────

type SessionDb = PrismaClient | Prisma.TransactionClient;

const CANCELLED_ENUM: SessionStatus = "CANCELLED";

export type CancelSessionResult =
  | { ok: true; session: Session }
  | { ok: false; error: "notFound" | "alreadyCancelled" | "alreadyRescheduled" | "sessionClosed" };

/**
 * Cancels one session. Money is never touched here (CLAUDE.md rule 2) — a
 * cancelled session's existing attendance/payment rows stay exactly as
 * recorded; if a payment needs undoing, that is `voidPayment`'s job, a
 * separate, explicit, audited action. "Roster and schedule update
 * correctly" (spec §7 criterion 11) is true by construction: `SessionAttendee`
 * rows are never deleted, and `deriveSessionDisplayStatus` already treats
 * `CANCELLED` as terminal regardless of the clock.
 *
 * R2: a closed session cannot be cancelled (`sessionClosed`) — it ran, and
 * its record is final. A session whose day ended is auto-closed by this call
 * first (lib/db/session-lifecycle.ts), then refused.
 */
export async function cancelSession(
  db: SessionDb,
  centerId: string,
  sessionId: string,
  options: { now?: Date } = {},
): Promise<CancelSessionResult> {
  return runInTransaction(db, async (tx): Promise<CancelSessionResult> => {
    const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, options.now, {
      allowTerminal: true,
      exclusive: true,
    });
    if (gate.status === "missing") return { ok: false, error: "notFound" };
    if (gate.status === "refused") return { ok: false, error: "sessionClosed" };
    if (gate.session.status === CANCELLED_ENUM) return { ok: false, error: "alreadyCancelled" };
    if (gate.session.rescheduledToId) return { ok: false, error: "alreadyRescheduled" };

    const updated = await tx.session.update({
      where: { id: sessionId },
      data: { status: CANCELLED_ENUM },
    });
    return { ok: true, session: updated };
  });
}

export type UpdateSessionShareOverrideResult =
  | { ok: true; session: Session }
  | { ok: false; error: "notFound" | "sessionClosed" };

/**
 * Sets or clears this one session's centre-cut override (M13, spec §5.1
 * "Center cut" — "overridable per class and per session"). `null` clears the
 * override back to "inherit the class's own centerShareType/
 * centerShareValue" — every session's state until this is called. Only
 * consulted by `recordPayment` at the moment a payment is frozen; never
 * touches an already-recorded payment's snapshots (CLAUDE.md rule 2).
 *
 * R2: refused on a closed session (`sessionClosed`) — no payment can be
 * recorded there any more, so an override would only rewrite its record.
 */
export async function updateSessionShareOverride(
  db: SessionDb,
  centerId: string,
  sessionId: string,
  override: { centerShareType: ShareType; centerShareValue: number } | null,
  options: { now?: Date } = {},
): Promise<UpdateSessionShareOverrideResult> {
  return runInTransaction(db, async (tx): Promise<UpdateSessionShareOverrideResult> => {
    const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, options.now, {
      allowTerminal: true,
      exclusive: true,
    });
    if (gate.status === "missing") return { ok: false, error: "notFound" };
    if (gate.status === "refused") return { ok: false, error: "sessionClosed" };

    const updated = await tx.session.update({
      where: { id: sessionId },
      data: {
        centerShareType: override?.centerShareType ?? null,
        centerShareValue: override?.centerShareValue ?? null,
      },
    });
    return { ok: true, session: updated };
  });
}

/**
 * A slot write refused over conflicts. `conflict` is DENY (refused whatever
 * the flag says); `conflictsNeedConfirmation` is WARN without
 * `confirmConflicts` (R3). Both carry the conflict list — never a generic
 * error — so the form can show exactly what clashes.
 */
export type ConflictRefusal = {
  ok: false;
  error: "conflict" | "conflictsNeedConfirmation";
  conflicts: GenerationConflict[];
};

export type RescheduleSessionResult =
  | { ok: true; session: Session; conflicts: GenerationConflict[] }
  | ConflictRefusal
  | {
      ok: false;
      error:
        | "notFound"
        | "cancelled"
        | "alreadyRescheduled"
        | "sessionClosed"
        | "duplicateSlot"
        | RoomSetError;
    };

/**
 * Moves one session to a new date/time — same-day at a different time, or a
 * future date (M15, spec §5.1 "Reschedule with linkage"). Unlike the pre-M15
 * behavior, the original row is never mutated in place: a **new** `Session`
 * is created at the target date/time and the original's `rescheduledToId` is
 * written immediately, so history reads "this session moved to that one"
 * rather than "this session was always on Thursday" — the original keeps
 * whatever attendance/payments it already carries, untouched (CLAUDE.md rule
 * 2), and is closed to any *new* attendance/payment from that point on
 * (`lib/db/attendance.ts`/`lib/db/payments.ts`'s `sessionRescheduled` guard).
 * Identical rule whether a teacher or centre staff initiates it — this
 * function has no caller-identity branch at all.
 *
 * R3: the replacement takes the original's **room set** (primary + extras)
 * unless `next.roomId`/`next.extraRoomIds` choose another one, which must be
 * a valid combination (`lib/db/room-sets.ts`'s `resolveRoomSet`). The
 * teacher/room conflict check (`findSessionConflicts`, docs/02 §11) is the
 * same one the generator uses, over the whole room set: `timeRangesOverlap`
 * compares the full start→end window, not just the start instant, so a
 * target slot free at its start but busy before it ends is still flagged.
 * DENY refuses; WARN refuses unless `confirmConflicts` (then saves and
 * audits the confirmation). `findSessionConflicts` already skips the
 * session's own class, so the moved session never "conflicts with itself"
 * (and the original slot it vacates occupies nothing once linked).
 *
 * The `(classGroupId, date, startTime)` unique constraint still applies to
 * the new row — if this class already has another session at the target
 * slot, the write fails with `duplicateSlot` rather than silently merging
 * two sessions.
 *
 * R2: a closed session cannot be rescheduled (`sessionClosed`); the closure
 * guard runs inside the same transaction as the write, so a session that
 * closes between the conflict check and the write is still refused.
 */
export async function rescheduleSession(
  db: PrismaClient,
  centerId: string,
  sessionId: string,
  next: {
    date: Date;
    startTime: string;
    endTime: string;
    /** R3 — omitted: copy the original's room set. */
    roomId?: string | null;
    extraRoomIds?: string[];
  },
  conflictPolicy: ConflictPolicy,
  // Only labels a conflict for display (`ScheduleConflict.className`, M13).
  locale = "en",
  options: { now?: Date } & ConflictConfirmation = {},
): Promise<RescheduleSessionResult> {
  const session = await db.session.findFirst({
    where: { centerId, id: sessionId },
    include: { extraRooms: { select: { roomId: true } } },
  });
  if (!session) return { ok: false, error: "notFound" };
  if (session.status === CANCELLED_ENUM) return { ok: false, error: "cancelled" };
  if (session.rescheduledToId) return { ok: false, error: "alreadyRescheduled" };
  if (session.closedAt) return { ok: false, error: "sessionClosed" };

  // The room set: the original's by default, or a newly chosen valid one.
  let roomId = session.roomId;
  let extraRoomIds = session.roomId ? session.extraRooms.map((extra) => extra.roomId) : [];
  if (next.roomId !== undefined) {
    const keep = effectiveRoomIds(roomId, extraRoomIds);
    const resolved = await resolveRoomSet(db, centerId, next.roomId, next.extraRoomIds ?? [], {
      requireActiveExcept: keep,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    roomId = next.roomId;
    extraRoomIds = next.roomId ? [...(next.extraRoomIds ?? [])] : [];
  }

  const existing = await loadSessionOccupancy(
    db,
    centerId,
    locale,
    startOfUtcDay(next.date),
    startOfUtcDay(next.date),
  );

  const found = findSessionConflicts(
    {
      classGroupId: session.classGroupId,
      teacherId: session.teacherId,
      roomId,
      roomIds: effectiveRoomIds(roomId, extraRoomIds),
      date: next.date,
      startTime: next.startTime,
      endTime: next.endTime,
    },
    existing,
  );
  const conflicts: GenerationConflict[] = found.map((conflict) => ({
    ...conflict,
    date: dateKey(next.date),
  }));

  const decision = decideConflicts(
    conflicts.length,
    conflictPolicy,
    options.confirmConflicts ?? true,
  );
  if (decision === "denied") return { ok: false, error: "conflict", conflicts };
  if (decision === "needsConfirmation") {
    return { ok: false, error: "conflictsNeedConfirmation", conflicts };
  }

  try {
    // One transaction: the new occurrence and the original's linkage are
    // written together, or not at all — never a replacement with no session
    // pointing at it, or a link to a replacement that doesn't exist.
    const outcome = await db.$transaction(async (tx) => {
      // The closure guard, inside the write's own transaction (R2). A refusal
      // is returned, not thrown, so a lazy end-of-day close still commits.
      const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, options.now, {
        allowTerminal: true,
        exclusive: true,
      });
      if (gate.status !== "open") return null;
      if (gate.session.status === CANCELLED_ENUM || gate.session.rescheduledToId) return null;

      const created = await tx.session.create({
        data: {
          centerId,
          classGroupId: session.classGroupId,
          teacherId: session.teacherId,
          roomId,
          date: next.date,
          startTime: next.startTime,
          endTime: next.endTime,
          priceSnapshot: session.priceSnapshot,
          centerShareType: session.centerShareType,
          centerShareValue: session.centerShareValue,
          description: session.description,
        },
      });
      await writeSessionExtraRooms(tx, centerId, created.id, extraRoomIds);
      await tx.session.update({
        where: { id: sessionId },
        data: { rescheduledToId: created.id },
      });
      if (options.confirmConflicts === true) {
        await writeConfirmedConflictAudit(tx, {
          centerId,
          actorUserId: options.actorUserId ?? null,
          entityType: "Session",
          entityId: created.id,
          context: "session.reschedule",
          conflicts,
        });
      }
      return created;
    });
    if (!outcome) return { ok: false, error: "sessionClosed" };
    return { ok: true, session: outcome, conflicts };
  } catch (error) {
    if (
      error instanceof Object &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { ok: false, error: "duplicateSlot" };
    }
    throw error;
  }
}

export type UpdateSessionRoomsResult =
  | { ok: true; session: Session; conflicts: GenerationConflict[] }
  | ConflictRefusal
  | {
      ok: false;
      error: "notFound" | "cancelled" | "alreadyRescheduled" | "sessionClosed" | RoomSetError;
    };

/**
 * Changes the room set of **one session only** (R3 — "the session edit
 * control can pick a primary room plus linked extras for that session").
 * Never touches the class, so it never changes the class's enrolment cap;
 * it changes which rooms this session keeps busy and the seat count shown
 * for it. The same combination rule and the same conflict contract as every
 * other slot write: DENY refuses, WARN refuses unless `confirmConflicts`
 * (then saves and audits). A cancelled, rescheduled or closed session is
 * refused — its record is final.
 */
export async function updateSessionRooms(
  db: PrismaClient,
  centerId: string,
  sessionId: string,
  next: { roomId: string | null; extraRoomIds: string[] },
  conflictPolicy: ConflictPolicy,
  locale = "en",
  options: { now?: Date } & ConflictConfirmation = {},
): Promise<UpdateSessionRoomsResult> {
  const session = await db.session.findFirst({
    where: { centerId, id: sessionId },
    include: { extraRooms: { select: { roomId: true } } },
  });
  if (!session) return { ok: false, error: "notFound" };
  if (session.status === CANCELLED_ENUM) return { ok: false, error: "cancelled" };
  if (session.rescheduledToId) return { ok: false, error: "alreadyRescheduled" };
  if (session.closedAt) return { ok: false, error: "sessionClosed" };

  const current = effectiveRoomIds(
    session.roomId,
    session.extraRooms.map((extra) => extra.roomId),
  );
  const resolved = await resolveRoomSet(db, centerId, next.roomId, next.extraRoomIds, {
    requireActiveExcept: current,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const extraRoomIds = next.roomId ? next.extraRoomIds : [];

  const existing = await loadSessionOccupancy(db, centerId, locale, session.date, session.date);
  const conflicts: GenerationConflict[] = findSessionConflicts(
    {
      classGroupId: session.classGroupId,
      teacherId: session.teacherId,
      roomId: next.roomId,
      roomIds: resolved.set.roomIds,
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
    },
    existing,
  ).map((conflict) => ({ ...conflict, date: dateKey(session.date) }));

  const decision = decideConflicts(
    conflicts.length,
    conflictPolicy,
    options.confirmConflicts ?? true,
  );
  if (decision === "denied") return { ok: false, error: "conflict", conflicts };
  if (decision === "needsConfirmation") {
    return { ok: false, error: "conflictsNeedConfirmation", conflicts };
  }

  const outcome = await runInTransaction(db, async (tx) => {
    const gate = await ensureSessionOpenOrAutoClose(tx, sessionId, centerId, options.now, {
      allowTerminal: true,
      exclusive: true,
    });
    if (gate.status !== "open") return null;
    if (gate.session.status === CANCELLED_ENUM || gate.session.rescheduledToId) return null;

    const updated = await tx.session.update({
      where: { id: sessionId },
      data: { roomId: next.roomId },
    });
    await writeSessionExtraRooms(tx, centerId, sessionId, extraRoomIds);
    if (options.confirmConflicts === true) {
      await writeConfirmedConflictAudit(tx, {
        centerId,
        actorUserId: options.actorUserId ?? null,
        entityType: "Session",
        entityId: sessionId,
        context: "session.rooms.update",
        conflicts,
      });
    }
    return updated;
  });
  if (!outcome) return { ok: false, error: "sessionClosed" };
  return { ok: true, session: outcome, conflicts };
}

// ─────────────────────────────────────────────────────────────────────────
// Read-side session policy (Today's Sessions dashboard + detail, M5).
// Kept in this file — not lib/db/classes.ts or lib/db/scoped.ts — because
// `npm run check:classes` already imports this module directly outside the
// Next.js runtime for `generateSessions`, so everything here stays free of
// `@/` aliases the same way (docs/02-architecture.md §5).
// ─────────────────────────────────────────────────────────────────────────

const CANCELLED_STATUS: SessionStatus = "CANCELLED";
const ACTIVE_ENROLLMENT_STATUS = "ACTIVE" as const;

/**
 * Fields a Today's Sessions dashboard row renders — never a full include.
 * A function of `centerId`, not a static object (M13): `subject`/`grade`
 * each carry a nested, centre-scoped `selections` lookup so the label shown
 * resolves this centre's own rename when it has one — no schema field
 * freezes a catalog entry's name, so every live read resolves the override.
 */
export function sessionListSelect(centerId: string) {
  return {
    id: true,
    date: true,
    startTime: true,
    endTime: true,
    status: true,
    rescheduledToId: true,
    closedAt: true,
    priceSnapshot: true,
    teacherId: true,
    classGroupId: true,
    classGroup: {
      select: {
        subject: {
          select: {
            nameAr: true,
            nameEn: true,
            selections: { where: { centerId }, select: { displayName: true }, take: 1 },
          },
        },
        grade: {
          select: {
            nameAr: true,
            nameEn: true,
            selections: { where: { centerId }, select: { displayName: true }, take: 1 },
          },
        },
        _count: { select: { enrollments: { where: { status: ACTIVE_ENROLLMENT_STATUS } } } },
      },
    },
    room: { select: { id: true, name: true, capacity: true } },
    // R3 — rooms combined with the primary for this session.
    extraRooms: {
      select: { room: { select: { id: true, name: true, capacity: true } } },
      orderBy: { createdAt: "asc" },
    },
    _count: { select: { attendees: true } },
  } satisfies Prisma.SessionSelect;
}

export type SessionListRow = Prisma.SessionGetPayload<{
  select: ReturnType<typeof sessionListSelect>;
}>;

/** A session detail page — every field it renders, including the roster. */
export function sessionDetailInclude(centerId: string) {
  const withSelection = { include: { selections: { where: { centerId } } } } as const;
  return {
    teacher: true,
    room: true,
    extraRooms: { include: { room: true }, orderBy: { createdAt: "asc" } },
    classGroup: { include: { subject: withSelection, grade: withSelection } },
    attendees: {
      include: {
        studentProfile: { include: { user: true } },
        enrollment: true,
        payments: { orderBy: { recordedAt: "desc" } },
      },
      orderBy: { createdAt: "asc" },
    },
  } satisfies Prisma.SessionInclude;
}

export type SessionDetailRow = Prisma.SessionGetPayload<{
  include: ReturnType<typeof sessionDetailInclude>;
}>;

export function sessionListWhere(filters: {
  from: Date;
  to: Date;
  teacherId?: string | null;
  subjectId?: string | null;
  classGroupId?: string | null;
}): Prisma.SessionWhereInput {
  const where: Prisma.SessionWhereInput = {
    date: { gte: filters.from, lte: filters.to },
  };
  if (filters.teacherId) where.teacherId = filters.teacherId;
  if (filters.classGroupId) where.classGroupId = filters.classGroupId;
  if (filters.subjectId) where.classGroup = { subjectId: filters.subjectId };
  return where;
}

export type SessionDisplayStatus =
  | "SCHEDULED"
  | "LIVE"
  | "COMPLETED"
  | "CANCELLED"
  | "RESCHEDULED";

/**
 * The status a session *displays*. Precedence, highest first:
 * - RESCHEDULED (M15) — derived from `rescheduledToId`, not stored: the
 *   original is neither cancelled (it still happens, on its replacement) nor
 *   SCHEDULED/COMPLETED by the clock (its own slot never occurred).
 * - CANCELLED — the stored value, terminal regardless of the clock.
 * - COMPLETED — the session is **closed** (R2): `closedAt` set (which also
 *   stores `status: COMPLETED`), or its calendar day has ended in the
 *   centre's timezone (it is closed AUTO on its next touch —
 *   lib/db/session-lifecycle.ts). Stored and displayed status agree.
 * - SCHEDULED — its start time has not come yet, in the centre's timezone.
 * - LIVE — started and not closed. A session stays LIVE past its end time
 *   until staff end it or its day ends, because until then it still accepts
 *   attendance corrections and payments; "Live" is what tells staff it is
 *   still open.
 *
 * `date` is a UTC-midnight calendar-day marker and `startTime` a bare
 * "HH:MM" wall-clock string in the centre's timezone, so `now` is read
 * through `zonedClock` (lib/scheduling.ts) — never compared in UTC.
 */
export function deriveSessionDisplayStatus(
  session: {
    status: SessionStatus;
    date: Date;
    startTime: string;
    endTime: string;
    rescheduledToId?: string | null;
    closedAt?: Date | null;
  },
  now: Date,
  timeZone: string,
): SessionDisplayStatus {
  if (session.rescheduledToId) return "RESCHEDULED";
  if (session.status === CANCELLED_STATUS) return "CANCELLED";
  if (session.closedAt || session.status === "COMPLETED") return "COMPLETED";

  const clock = zonedClock(now, timeZone);
  const dayKey = dateKey(session.date);
  if (dayKey > clock.dayKey) return "SCHEDULED";
  if (dayKey < clock.dayKey) return "COMPLETED";
  if (clock.minutes < parseTimeToMinutesSafe(session.startTime)) return "SCHEDULED";
  return "LIVE";
}

function parseTimeToMinutesSafe(value: string): number {
  try {
    return parseTimeToMinutes(value);
  } catch {
    const [hours, minutes] = value.split(":").map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }
}

/** A short label for the session in a list/receipt ("Math · Grade 10"). */
export function sessionDisplayName(
  locale: string,
  row: {
    classGroup: {
      subject: CatalogWithSelection | null;
      grade: CatalogWithSelection | null;
    };
  },
): string {
  return (
    [
      catalogLabelWithSelection(locale, row.classGroup.subject),
      catalogLabelWithSelection(locale, row.classGroup.grade),
    ]
      .filter(Boolean)
      .join(" · ") || "—"
  );
}
