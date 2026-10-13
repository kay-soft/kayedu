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

export type UnlinkRoomsResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: "combinationInUse"; classes: number; sessions: number };

/**
 * Removes a link — refused while an **active class** or a **non-closed
 * future session** still uses that pair as primary + extra (the refusal
 * carries both counts so the message can name them). Past and closed
 * sessions keep their recorded rooms; they never block an unlink.
 */
export async function unlinkRooms(
  db: Db,
  centerId: string,
  firstRoomId: string,
  secondRoomId: string,
  clock: { now: Date; timeZone: string },
): Promise<UnlinkRoomsResult> {
  const pair = normalizeRoomPair(firstRoomId, secondRoomId);
  if (!pair) return { ok: true, removed: false };

  const usage = await combinationUsage(db, centerId, [pair], clock);
  if (usage.classes + usage.sessions > 0) {
    return { ok: false, error: "combinationInUse", ...usage };
  }

  const removed = await db.roomLink.deleteMany({
    where: scopedWhere(centerId, pair),
  });
  return { ok: true, removed: removed.count > 0 };
}

export type SetRoomLinksResult =
  | { ok: true; added: string[]; removed: string[] }
  | {
      ok: false;
      error: "selfLink" | "roomNotFound" | "combinationInUse";
      classes?: number;
      sessions?: number;
    };

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
): Promise<SetRoomLinksResult> {
  const wanted = new Set(linkedRoomIds);
  if (wanted.has(roomId)) return { ok: false, error: "selfLink" };

  return db.$transaction(async (tx): Promise<SetRoomLinksResult> => {
    const room = await tx.room.findFirst({ where: scopedWhere(centerId, { id: roomId }) });
    if (!room) return { ok: false, error: "roomNotFound" };

    const current = new Set(
      (await loadRoomLinks(tx, centerId))
        .filter((link) => link.roomAId === roomId || link.roomBId === roomId)
        .map((link) => (link.roomAId === roomId ? link.roomBId : link.roomAId)),
    );
    const added = [...wanted].filter((id) => !current.has(id));
    const removed = [...current].filter((id) => !wanted.has(id));

    if (removed.length > 0) {
      const pairs = removed
        .map((id) => normalizeRoomPair(roomId, id))
        .filter((pair): pair is { roomAId: string; roomBId: string } => pair !== null);
      const usage = await combinationUsage(tx, centerId, pairs, clock);
      if (usage.classes + usage.sessions > 0) {
        return { ok: false, error: "combinationInUse", ...usage };
      }
      for (const pair of pairs) {
        await tx.roomLink.deleteMany({ where: scopedWhere(centerId, pair) });
      }
    }

    for (const id of added) {
      const result = await linkRooms(tx, centerId, roomId, id);
      if (!result.ok) throw new RoomLinkWriteError(result.error);
    }

    return { ok: true, added, removed };
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

  const classMatch: Prisma.ClassGroupRoomWhereInput[] = pairs.flatMap((pair) => [
    { roomId: pair.roomBId, classGroup: { roomId: pair.roomAId } },
    { roomId: pair.roomAId, classGroup: { roomId: pair.roomBId } },
  ]);
  const sessionMatch: Prisma.SessionRoomWhereInput[] = pairs.flatMap((pair) => [
    { roomId: pair.roomBId, session: { roomId: pair.roomAId } },
    { roomId: pair.roomAId, session: { roomId: pair.roomBId } },
  ]);

  const [classRows, sessionRows] = await Promise.all([
    db.classGroupRoom.findMany({
      where: scopedWhere(centerId, { OR: classMatch, classGroup: { active: true } }),
      select: { classGroupId: true },
      distinct: ["classGroupId"],
    }),
    db.sessionRoom.findMany({
      where: scopedWhere(centerId, { OR: sessionMatch, session: futureOpenSessionWhere(clock) }),
      select: { sessionId: true },
      distinct: ["sessionId"],
    }),
  ]);
  return { classes: classRows.length, sessions: sessionRows.length };
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
