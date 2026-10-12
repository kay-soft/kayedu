/**
 * The single place "how many seats does this class actually have" is decided
 * (M15, revised R3 — spec §5.1 "Capacity" and "Class capacity removed",
 * CLAUDE.md rule 10's "one normalizer per rule" spirit). Enrolment is
 * hard-capped by the **class's room set**: the summed capacity of its primary
 * room plus every extra room combined with it (`lib/rooms.ts`'s
 * `effectiveCapacity`, the one implementation of that sum). There is no
 * class-level capacity any more — R3 dropped `ClassGroup.capacity`,
 * reversing M15's "min(class capacity, room capacity)". `0` means unlimited
 * — the existing convention (`docs/01-data-model.md §6`) — so a class with
 * no room, or whose room set includes a room with no capacity configured,
 * is uncapped. Attendance is never capped (`lib/db/attendance.ts` has no
 * capacity check at all).
 *
 * Deliberately free of runtime imports, like `lib/scheduling.ts` and
 * `lib/money.ts`: `npm run check:enrollment` exercises this module directly.
 */
export function enrollmentCap(roomSetCapacity: number | null | undefined): number {
  return roomSetCapacity && roomSetCapacity > 0 ? roomSetCapacity : 0;
}

/** `0` means unlimited — `activeCount >= cap` is never true when `cap` is 0. */
export function isAtCapacity(activeCount: number, cap: number): boolean {
  return cap > 0 && activeCount >= cap;
}

/** How long a rejected student must wait before re-requesting the same class. */
export const RESERVATION_COOLDOWN_DAYS = 7;

export function cooldownUntil(rejectedAt: Date): Date {
  const until = new Date(rejectedAt);
  until.setUTCDate(until.getUTCDate() + RESERVATION_COOLDOWN_DAYS);
  return until;
}

export function isInCooldown(rejectedAt: Date, now: Date): boolean {
  return now < cooldownUntil(rejectedAt);
}
