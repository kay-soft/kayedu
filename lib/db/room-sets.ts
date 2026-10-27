import type { Prisma, PrismaClient, SessionStatus } from "@prisma/client";

// Relative imports on purpose — `npm run check:rooms` exercises this module
// directly, outside the Next.js runtime (same reasoning as lib/db/sessions.ts
// and lib/db/payment-methods.ts). The client is injected, never imported.
import {
  combinationError,
  effectiveCapacity,
  effectiveRoomIds,
  normalizeRoomPair,
  type RoomCombinationError,
  type RoomLinkPair,
} from "../rooms.ts";
import { todayInTimezone } from "../scheduling.ts";
import { sessionDisplayName, sessionLabelSelect } from "../session-label.ts";
import { writeAuditRow } from "./audit-row.ts";
import { scopedData, scopedWhere } from "./tenant-scope.ts";

/**
 * Room sets at the database (R3, docs/00 §5.1 "Joinable rooms / room sets",
 * docs/01 "Config layer"). The pure rules — normalization, the star-not-
 * transitive combination rule, the capacity sum — live in `lib/rooms.ts`;
 * this module is the only place that **writes** `RoomLink`, `ClassGroupRoom`
 * or `SessionRoom`, and every write resolves each room inside the caller's
 * own `centerId` first, so a room id from another centre is simply "not
 * found" (CLAUDE.md rule 1).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const CANCELLED: SessionStatus = "CANCELLED";

// ── Links ──────────────────────────────────────────────────────────────────

/** Every link of one centre — the input to `lib/rooms.ts`'s combination rule. */
export async function loadRoomLinks(db: Db, centerId: string): Promise<RoomLinkPair[]> {
  return db.roomLink.findMany({
    where: scopedWhere(centerId),
    select: { roomAId: true, roomBId: true },
  });
}

export type LinkRoomsResult =
  | { ok: true; created: boolean }
  | { ok: false; error: "selfLink" | "roomNotFound" };

/**
 * Links two rooms of one centre. Stored once, normalized (`roomAId <
 * roomBId`); linking an already-linked pair is a no-op (`created: false`).
 * A self-link is refused, and so is any room that does not resolve inside
 * `centerId` — which is what refuses a cross-centre link.
 */
export async function linkRooms(
  db: Db,
  centerId: string,
  firstRoomId: string,
  secondRoomId: string,
): Promise<LinkRoomsResult> {
  const pair = normalizeRoomPair(firstRoomId, secondRoomId);
  if (!pair) return { ok: false, error: "selfLink" };

  const found = await db.room.count({
    where: scopedWhere(centerId, { id: { in: [pair.roomAId, pair.roomBId] } }),
  });
  if (found !== 2) return { ok: false, error: "roomNotFound" };

  const created = await db.roomLink.createMany({
    data: [scopedData(centerId, pair)],
    skipDuplicates: true,
  });
  return { ok: true, created: created.count > 0 };
}

/** What still uses a combination — the counts, and the first few by name. */
export type CombinationUsageDetail = {
  classes: number;
  sessions: number;
  /** Class names ("Maths · Grade 5"), at most `USAGE_LIST_LIMIT`. */
  classNames: string[];
  /** Upcoming sessions (name, day, time), at most `USAGE_LIST_LIMIT`, soonest first. */
  sessionList: { id: string; name: string; date: Date; startTime: string; endTime: string }[];
};

/** How many named classes / sessions a refusal lists; the counts stay exact. */
export const USAGE_LIST_LIMIT = 5;

export type UnlinkRoomsResult =
  | { ok: true; removed: boolean }
  | ({ ok: false; error: "combinationInUse" } & CombinationUsageDetail);

/**
 * Removes a link — refused while an **active class** or a **non-closed
 * future session** still uses that pair as primary + extra (the refusal
 * carries both counts and the first few names so the message can say what
 * uses it). Past and closed sessions keep their recorded rooms; they never
 * block an unlink.
 */
export async function unlinkRooms(
  db: Db,
  centerId: string,
  firstRoomId: string,
  secondRoomId: string,
  clock: { now: Date; timeZone: string },
  locale = "en",
): Promise<UnlinkRoomsResult> {
  const pair = normalizeRoomPair(firstRoomId, secondRoomId);
  if (!pair) return { ok: true, removed: false };

  const usage = await combinationUsage(db, centerId, [pair], clock);
  if (usage.classes + usage.sessions > 0) {
    return {
      ok: false,
      error: "combinationInUse",
      ...(await combinationUsageDetail(db, centerId, [pair], clock, locale, usage)),
    };
  }

  const removed = await db.roomLink.deleteMany({
    where: scopedWhere(centerId, pair),
  });
  return { ok: true, removed: removed.count > 0 };
}

export type SetRoomLinksResult =
  | { ok: true; roomId: string; added: string[]; removed: string[] }
  | { ok: false; error: "selfLink" | "roomNotFound" | "roomInactive" }
  | ({ ok: false; error: "combinationInUse" } & CombinationUsageDetail);

type LinkPlan = {
  added: string[];
  removed: string[];
  removedPairs: { roomAId: string; roomBId: string }[];
};

/**
 * Works out the diff between `roomId`'s stored links and `linkedRoomIds`, and
 * refuses it — **before anything is written** — when a removal is in use, a
 * new link points at a room that is not in this centre (`roomNotFound`) or is
 * inactive (`roomInactive`: only active rooms are offered). `roomId` null =
 * a room that does not exist yet (nothing to remove). Pairs are stored once,
 * so a link seen from either room is the same row.
 */
async function planRoomLinkDiff(
  tx: Prisma.TransactionClient,
  centerId: string,
  roomId: string | null,
  linkedRoomIds: readonly string[],
  clock: { now: Date; timeZone: string },
  locale: string,
): Promise<{ ok: true; plan: LinkPlan } | Exclude<SetRoomLinksResult, { ok: true }>> {
  const wanted = new Set(linkedRoomIds);
  if (roomId && wanted.has(roomId)) return { ok: false, error: "selfLink" };

  const current = new Set(
    roomId
      ? (await loadRoomLinks(tx, centerId))
          .filter((link) => link.roomAId === roomId || link.roomBId === roomId)
          .map((link) => (link.roomAId === roomId ? link.roomBId : link.roomAId))
      : [],
  );
  const added = [...wanted].filter((id) => !current.has(id));
  const removed = [...current].filter((id) => !wanted.has(id));

  if (added.length > 0) {
    const rows = await tx.room.findMany({
      where: scopedWhere(centerId, { id: { in: added } }),
      select: { id: true, active: true },
    });
    if (rows.length !== added.length) return { ok: false, error: "roomNotFound" };
    if (rows.some((row) => !row.active)) return { ok: false, error: "roomInactive" };
  }

  const removedPairs = roomId
    ? removed
        .map((id) => normalizeRoomPair(roomId, id))
        .filter((pair): pair is { roomAId: string; roomBId: string } => pair !== null)
    : [];
  if (removedPairs.length > 0) {
    const usage = await combinationUsage(tx, centerId, removedPairs, clock);
    if (usage.classes + usage.sessions > 0) {
      return {
        ok: false,
        error: "combinationInUse",
        ...(await combinationUsageDetail(tx, centerId, removedPairs, clock, locale, usage)),
      };
    }
  }
  return { ok: true, plan: { added, removed, removedPairs } };
}

async function writeRoomLinkDiff(
  tx: Prisma.TransactionClient,
  centerId: string,
  roomId: string,
  plan: LinkPlan,
): Promise<void> {
  for (const pair of plan.removedPairs) {
    await tx.roomLink.deleteMany({ where: scopedWhere(centerId, pair) });
  }
  for (const id of plan.added) {
    const result = await linkRooms(tx, centerId, roomId, id);
    if (!result.ok) throw new RoomLinkWriteError(result.error);
  }
}

/**
 * The "Can be combined with" save for one room: makes `roomId`'s links
 * exactly `linkedRoomIds`, adding and removing pairs as needed, in one
 * transaction. A removal that is in use refuses the whole save — nothing is
 * half-applied.
 */
export async function setRoomLinks(
  db: PrismaClient,
  centerId: string,
  roomId: string,
  linkedRoomIds: readonly string[],
  clock: { now: Date; timeZone: string },
  locale = "en",
  actorUserId: string | null = null,
): Promise<SetRoomLinksResult> {
  return saveRoomWithLinks(db, centerId, roomId, null, linkedRoomIds, clock, locale, actorUserId);
}

/**
 * The Add room / Edit room save: the room's own fields **and** its link set,
 * in one transaction. `roomId` null creates the room (then links it);
 * otherwise `fields` (when given) updates it. The link diff is planned and
 * refused first, so a refused save changes nothing — not the name, not the
 * capacity, not a link. Every room id resolves inside `centerId`.
 *
 * Rule 7: the `room.link` / `room.unlink` audit rows (one per pair, ids only)
 * are written on this same transaction, so a link can never commit without its
 * row — nor a row without its link. `actorUserId` is the signed-in user.
 */
export async function saveRoomWithLinks(
  db: PrismaClient,
  centerId: string,
  roomId: string | null,
  fields: { name: string; capacity: number } | null,
  linkedRoomIds: readonly string[],
  clock: { now: Date; timeZone: string },
  locale = "en",
  actorUserId: string | null = null,
): Promise<SetRoomLinksResult> {
  return db.$transaction(async (tx): Promise<SetRoomLinksResult> => {
    if (roomId) {
      const room = await tx.room.findFirst({ where: scopedWhere(centerId, { id: roomId }) });
      if (!room) return { ok: false, error: "roomNotFound" };
    }
    const planned = await planRoomLinkDiff(tx, centerId, roomId, linkedRoomIds, clock, locale);
    if (!planned.ok) return planned;

    let savedId = roomId;
    if (!savedId) {
      if (!fields) return { ok: false, error: "roomNotFound" };
      savedId = (await tx.room.create({ data: scopedData(centerId, fields), select: { id: true } })).id;
    } else if (fields) {
      await tx.room.updateMany({ where: scopedWhere(centerId, { id: savedId }), data: fields });
    }

    await writeRoomLinkDiff(tx, centerId, savedId, planned.plan);
    for (const [action, otherRoomIds] of [
      ["room.link", planned.plan.added],
      ["room.unlink", planned.plan.removed],
    ] as const) {
      for (const otherRoomId of otherRoomIds) {
        await writeAuditRow(tx, {
          centerId,
          actorUserId,
          action,
          entityType: "Room",
          entityId: savedId,
          after: { roomId: savedId, otherRoomId },
        });
      }
    }
    return { ok: true, roomId: savedId, added: planned.plan.added, removed: planned.plan.removed };
  }).catch((error: unknown) => {
    if (error instanceof RoomLinkWriteError) return { ok: false as const, error: error.reason };
    throw error;
  });
}

class RoomLinkWriteError extends Error {
  readonly reason: "selfLink" | "roomNotFound";
  constructor(reason: "selfLink" | "roomNotFound") {
    super(reason);
    this.reason = reason;
  }
}

// ── "Is this combination / room in use?" ───────────────────────────────────

/**
 * The `where` for "a session that still matters for planning": not
 * cancelled, not the original slot of a reschedule, not closed, and on or
 * after today in the centre's timezone.
 */
function futureOpenSessionWhere(clock: { now: Date; timeZone: string }): Prisma.SessionWhereInput {
  const today = todayInTimezone(clock.timeZone, clock.now);
  return {
    status: { not: CANCELLED },
    rescheduledToId: null,
    closedAt: null,
    date: { gte: today },
  };
}

/**
 * How many active classes and non-closed future sessions use any of
 * `pairs` as primary + extra. Counts distinct classes/sessions.
 */
export async function combinationUsage(
  db: Db,
  centerId: string,
  pairs: readonly { roomAId: string; roomBId: string }[],
  clock: { now: Date; timeZone: string },
): Promise<{ classes: number; sessions: number }> {
  if (pairs.length === 0) return { classes: 0, sessions: 0 };
  const { classWhere, sessionWhere } = pairUsageWhere(centerId, pairs, clock);

  const [classRows, sessionRows] = await Promise.all([
    db.classGroupRoom.findMany({
      where: classWhere,
      select: { classGroupId: true },
      distinct: ["classGroupId"],
    }),
    db.sessionRoom.findMany({
      where: sessionWhere,
      select: { sessionId: true },
      distinct: ["sessionId"],
    }),
  ]);
  return { classes: classRows.length, sessions: sessionRows.length };
}

/** The one definition of "uses this pair as primary + extra" — counts and names share it. */
function pairUsageWhere(
  centerId: string,
  pairs: readonly { roomAId: string; roomBId: string }[],
  clock: { now: Date; timeZone: string },
): { classWhere: Prisma.ClassGroupRoomWhereInput; sessionWhere: Prisma.SessionRoomWhereInput } {
  const classMatch: Prisma.ClassGroupRoomWhereInput[] = pairs.flatMap((pair) => [
    { roomId: pair.roomBId, classGroup: { roomId: pair.roomAId } },
    { roomId: pair.roomAId, classGroup: { roomId: pair.roomBId } },
  ]);
  const sessionMatch: Prisma.SessionRoomWhereInput[] = pairs.flatMap((pair) => [
    { roomId: pair.roomBId, session: { roomId: pair.roomAId } },
    { roomId: pair.roomAId, session: { roomId: pair.roomBId } },
  ]);
  return {
    classWhere: scopedWhere(centerId, { OR: classMatch, classGroup: { active: true } }),
    sessionWhere: scopedWhere(centerId, { OR: sessionMatch, session: futureOpenSessionWhere(clock) }),
  };
}

/**
 * `combinationUsage`, plus the first `USAGE_LIST_LIMIT` classes and sessions
 * by name — what an "in use" refusal tells staff to go and change. A class is
 * named like a session of it ("Maths · Grade 5", the centre's own catalog
 * names, `lib/session-label.ts`); a session by that name, its day and time.
 */
export async function combinationUsageDetail(
  db: Db,
  centerId: string,
  pairs: readonly { roomAId: string; roomBId: string }[],
  clock: { now: Date; timeZone: string },
  locale: string,
  counts?: { classes: number; sessions: number },
): Promise<CombinationUsageDetail> {
  const usage = counts ?? (await combinationUsage(db, centerId, pairs, clock));
  if (usage.classes + usage.sessions === 0) return { ...usage, classNames: [], sessionList: [] };
  const { classWhere, sessionWhere } = pairUsageWhere(centerId, pairs, clock);
  const label = sessionLabelSelect(centerId);

  const [classRows, sessionRows] = await Promise.all([
    db.classGroupRoom.findMany({
      where: classWhere,
      select: { classGroup: { select: { subject: label.subject, grade: label.grade } } },
      distinct: ["classGroupId"],
      orderBy: { createdAt: "asc" },
      take: USAGE_LIST_LIMIT,
    }),
    db.sessionRoom.findMany({
      where: sessionWhere,
      select: {
        session: {
          select: { id: true, date: true, startTime: true, endTime: true, ...label },
        },
      },
      distinct: ["sessionId"],
      orderBy: [{ session: { date: "asc" } }, { session: { startTime: "asc" } }],
      take: USAGE_LIST_LIMIT,
    }),
  ]);

  return {
    ...usage,
    classNames: classRows.map((row) => sessionDisplayName(locale, { classGroup: row.classGroup })),
    sessionList: sessionRows.map(({ session }) => ({
      id: session.id,
      name: sessionDisplayName(locale, session),
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
    })),
  };
}

/**
 * How many active classes and non-closed future sessions use `roomId` as
 * part of a **combined** room set (as the primary of a set with extras, or
 * as an extra). What refuses deactivating or deleting a room while a
 * combination depends on it.
 */
export async function roomCombinationUsage(
  db: Db,
  centerId: string,
  roomId: string,
  clock: { now: Date; timeZone: string },
): Promise<{ classes: number; sessions: number }> {
  const [classRows, sessionRows] = await Promise.all([
    db.classGroupRoom.findMany({
      where: scopedWhere(centerId, {
        OR: [{ roomId }, { classGroup: { roomId } }],
        classGroup: { active: true },
      }),
      select: { classGroupId: true },
      distinct: ["classGroupId"],
    }),
    db.sessionRoom.findMany({
      where: scopedWhere(centerId, {
        OR: [{ roomId }, { session: { roomId } }],
        session: futureOpenSessionWhere(clock),
      }),
      select: { sessionId: true },
      distinct: ["sessionId"],
    }),
  ]);
  return { classes: classRows.length, sessions: sessionRows.length };
}

// ── Validating and writing a room set ──────────────────────────────────────

export type RoomSetError = RoomCombinationError | "roomNotFound" | "roomInactive";

export type ResolvedRoomSet = {
  roomIds: string[];
  rooms: { id: string; name: string; capacity: number }[];
};

/**
 * Resolves a proposed primary + extras inside `centerId`: every room must
 * exist there (cross-centre → `roomNotFound`), be **active** unless it is
 * already part of the set being edited (`requireActiveExcept` — a room
 * deactivated after it was chosen may stay, but cannot be newly picked), and
 * every extra must be linked to the primary (`lib/rooms.ts`'s
 * `combinationError`). The one validator the class form, the session room
 * edit and reschedule all share.
 */
export async function resolveRoomSet(
  db: Db,
  centerId: string,
  primaryId: string | null,
  extraIds: readonly string[],
  options: { requireActiveExcept?: readonly string[] } = {},
): Promise<{ ok: true; set: ResolvedRoomSet } | { ok: false; error: RoomSetError }> {
  if (extraIds.length > 0 && !primaryId) return { ok: false, error: "noPrimary" };
  const ids = effectiveRoomIds(primaryId, extraIds);
  if (ids.length === 0) return { ok: true, set: { roomIds: [], rooms: [] } };

  const rows = await db.room.findMany({
    where: scopedWhere(centerId, { id: { in: ids } }),
    select: { id: true, name: true, capacity: true, active: true },
  });
  if (rows.length !== ids.length) return { ok: false, error: "roomNotFound" };
  const exempt = new Set(options.requireActiveExcept ?? []);
  if (rows.some((row) => !row.active && !exempt.has(row.id))) {
    return { ok: false, error: "roomInactive" };
  }

  const error = combinationError(primaryId, extraIds, await loadRoomLinks(db, centerId));
  if (error) return { ok: false, error };

  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    ok: true,
    set: {
      roomIds: ids,
      rooms: ids.map((id) => {
        const row = byId.get(id)!;
        return { id: row.id, name: row.name, capacity: row.capacity };
      }),
    },
  };
}

/** Replaces a class's extra rooms with exactly `extraIds`. */
export async function writeClassExtraRooms(
  db: Db,
  centerId: string,
  classGroupId: string,
  extraIds: readonly string[],
): Promise<void> {
  await db.classGroupRoom.deleteMany({
    where: scopedWhere(centerId, { classGroupId, roomId: { notIn: [...extraIds] } }),
  });
  if (extraIds.length > 0) {
    await db.classGroupRoom.createMany({
      data: extraIds.map((roomId) => scopedData(centerId, { classGroupId, roomId })),
      skipDuplicates: true,
    });
  }
}

/** Replaces a session's extra rooms with exactly `extraIds`. */
export async function writeSessionExtraRooms(
  db: Db,
  centerId: string,
  sessionId: string,
  extraIds: readonly string[],
): Promise<void> {
  await db.sessionRoom.deleteMany({
    where: scopedWhere(centerId, { sessionId, roomId: { notIn: [...extraIds] } }),
  });
  if (extraIds.length > 0) {
    await db.sessionRoom.createMany({
      data: extraIds.map((roomId) => scopedData(centerId, { sessionId, roomId })),
      skipDuplicates: true,
    });
  }
}

// ── Reading a class's room set and its seats ───────────────────────────────

export type ClassRoomSet = {
  roomId: string | null;
  extraRoomIds: string[];
  rooms: { id: string; name: string; capacity: number }[];
  /** `lib/rooms.ts`'s `effectiveCapacity` — 0 = uncapped. */
  capacity: number;
};

/** A class's primary + extra rooms, as stored, and their summed capacity. */
export async function loadClassRoomSet(
  db: Db,
  centerId: string,
  classGroupId: string,
): Promise<ClassRoomSet | null> {
  const row = await db.classGroup.findFirst({
    where: scopedWhere(centerId, { id: classGroupId }),
    select: {
      roomId: true,
      room: { select: { id: true, name: true, capacity: true } },
      extraRooms: {
        select: { room: { select: { id: true, name: true, capacity: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!row) return null;
  return classRoomSetFrom(row);
}

/** The same as `loadClassRoomSet`, from rows a caller already selected. */
export function classRoomSetFrom(row: {
  roomId: string | null;
  room: { id: string; name: string; capacity: number } | null;
  extraRooms: { room: { id: string; name: string; capacity: number } }[];
}): ClassRoomSet {
  const rooms = row.room ? [row.room, ...row.extraRooms.map((extra) => extra.room)] : [];
  return {
    roomId: row.roomId,
    extraRoomIds: row.room ? row.extraRooms.map((extra) => extra.room.id) : [],
    rooms,
    capacity: effectiveCapacity(rooms),
  };
}

/** The Prisma `select` fragment `classRoomSetFrom` reads. */
export const ROOM_SET_SELECT = {
  roomId: true,
  room: { select: { id: true, name: true, capacity: true } },
  extraRooms: {
    select: { room: { select: { id: true, name: true, capacity: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.ClassGroupSelect;
