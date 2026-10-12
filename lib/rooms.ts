/**
 * The single owner of "which rooms does this class/session use, may they be
 * combined, and how many seats do they add up to" (R3, docs/00 §5.1
 * "Joinable rooms / room sets", docs/02 §11). CLAUDE.md rule 10: there is no
 * second implementation of any of these anywhere — the class form, the
 * session room picker, the enrolment cap, the class-sessions engine and the
 * conflict check all call in here.
 *
 * A room set is one **primary** room plus zero or more **extra** rooms. Every
 * extra must be linked to the primary (`RoomLink`) — a star around the
 * primary, not a transitive closure: with A-B and B-C linked, A+C is not a
 * valid set unless A-C is linked too, and neither is A+B+C with A primary.
 *
 * Deliberately free of runtime imports, like `lib/scheduling.ts` and
 * `lib/capacity.ts`: `npm run check:rooms` exercises it directly.
 */

/** One stored link. Order does not matter to any reader here. */
export type RoomLinkPair = { roomAId: string; roomBId: string };

/**
 * The normalized storage order of a pair (R3: each pair is stored once,
 * `roomAId < roomBId`, compared as strings). `null` for a self-pair, which
 * is never a valid link.
 */
export function normalizeRoomPair(
  first: string,
  second: string,
): { roomAId: string; roomBId: string } | null {
  if (first === second) return null;
  return first < second
    ? { roomAId: first, roomBId: second }
    : { roomAId: second, roomBId: first };
}

/** Every room id `roomId` is directly linked to. */
export function linkedRoomIds(roomId: string, links: readonly RoomLinkPair[]): Set<string> {
  const linked = new Set<string>();
  for (const link of links) {
    if (link.roomAId === roomId) linked.add(link.roomBId);
    else if (link.roomBId === roomId) linked.add(link.roomAId);
  }
  return linked;
}

/**
 * The full set of rooms a class/session occupies: the primary first, then
 * each extra once, never the primary twice. No primary means no rooms at
 * all — extras without a primary are meaningless and are dropped.
 */
export function effectiveRoomIds(
  primaryId: string | null | undefined,
  extraIds: readonly string[] = [],
): string[] {
  if (!primaryId) return [];
  const ids = [primaryId];
  for (const id of extraIds) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Seats across a room set: the sum of the rooms' capacities. A room with
 * capacity `0` means "no capacity configured" — and it makes the **whole
 * set** uncapped (returns `0`), because a set that includes an unlimited
 * room has no finite seat count to enforce. An empty set (a class with no
 * room) is uncapped too. `0` is the codebase-wide "unlimited" convention
 * (`lib/capacity.ts`'s `isAtCapacity`).
 */
export function effectiveCapacity(rooms: readonly { capacity: number }[]): number {
  if (rooms.length === 0) return 0;
  let total = 0;
  for (const room of rooms) {
    if (room.capacity <= 0) return 0;
    total += room.capacity;
  }
  return total;
}

export type RoomCombinationError = "duplicateExtra" | "extraIsPrimary" | "notLinked" | "noPrimary";

/**
 * Why a proposed set is invalid, or `null` when it is valid. Valid = a
 * primary is chosen whenever there are extras, no extra repeats or equals
 * the primary, and **every extra is linked to the primary** (star, not
 * transitive).
 */
export function combinationError(
  primaryId: string | null | undefined,
  extraIds: readonly string[],
  links: readonly RoomLinkPair[],
): RoomCombinationError | null {
  if (extraIds.length === 0) return null;
  if (!primaryId) return "noPrimary";
  const seen = new Set<string>();
  const linked = linkedRoomIds(primaryId, links);
  for (const id of extraIds) {
    if (id === primaryId) return "extraIsPrimary";
    if (seen.has(id)) return "duplicateExtra";
    seen.add(id);
    if (!linked.has(id)) return "notLinked";
  }
  return null;
}

export function isValidCombination(
  primaryId: string | null | undefined,
  extraIds: readonly string[],
  links: readonly RoomLinkPair[],
): boolean {
  return combinationError(primaryId, extraIds, links) === null;
}

/**
 * Every unordered pair a room set relies on — what "this combination is in
 * use" means when a link is about to be removed (the primary paired with
 * each extra).
 */
export function combinationPairs(
  primaryId: string | null | undefined,
  extraIds: readonly string[],
): { roomAId: string; roomBId: string }[] {
  if (!primaryId) return [];
  const pairs: { roomAId: string; roomBId: string }[] = [];
  for (const id of extraIds) {
    const pair = normalizeRoomPair(primaryId, id);
    if (pair) pairs.push(pair);
  }
  return pairs;
}
