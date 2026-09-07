/**
 * The single place "how many seats does this class actually have" is decided
 * (M15, spec §5.1 "Capacity", CLAUDE.md rule 10's "one normalizer per rule"
 * spirit). Enrolment is hard-capped by the assigned **room**'s capacity
 * (docs/01-data-model.md §2 "Room" — "Capacity is the hard cap on enrolment
 * and deliberately not a cap on attendance"); `ClassGroup.capacity` stays a
 * genuine, independently-configurable planning target (a manager may want
 * fewer students than the room could hold), so the enforced cap is the
 * smaller of the two non-zero values. `0` means unlimited on both fields —
 * the existing convention (`docs/01-data-model.md §6`) — so "no room
 * assigned" or "room capacity 0" never tightens a class that has no cap of
 * its own.
 *
 * Deliberately free of runtime imports, like `lib/scheduling.ts` and
 * `lib/money.ts`: `npm run check:enrollment` exercises this module directly.
 */
export function enrollmentCap(
  classCapacity: number,
  roomCapacity: number | null | undefined,
): number {
  const caps = [classCapacity, roomCapacity ?? 0].filter((cap) => cap > 0);
  return caps.length > 0 ? Math.min(...caps) : 0;
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
