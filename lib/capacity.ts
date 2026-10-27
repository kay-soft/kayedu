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

/** "Few seats left" from this many free seats down to one (F5). */
export const FEW_SEATS_LEFT = 3;

export type SeatStatus = "open" | "few" | "full";

/**
 * What a guest is told about a class's seats (F5, public Explore): a status,
 * never a number — neither the enrolled count nor the seats left leaves the
 * server. An uncapped class (`cap` 0) is always open.
 */
export function seatStatus(activeCount: number, cap: number): SeatStatus {
  if (isAtCapacity(activeCount, cap)) return "full";
  if (cap > 0 && cap - activeCount <= FEW_SEATS_LEFT) return "few";
  return "open";
}

/**
 * F6 — one session's seats (docs/00 §5.1 "Single-session booking"). A
 * session's seats are its **class's** seat limit (the room set, `enrollmentCap`;
 * 0 = uncapped). What is used: the class's active enrolments, the session's
 * CONFIRMED bookings, and walk-in drop-ins already checked in without a
 * booking. `maxBookingSeats` (null = none) caps the CONFIRMED bookings alone.
 */
export type SessionSeatUsage = {
  activeEnrollments: number;
  confirmedBookings: number;
  walkIns: number;
};

export function sessionSeatsUsed(usage: SessionSeatUsage): number {
  return usage.activeEnrollments + usage.confirmedBookings + usage.walkIns;
}

export type BookingSeatError = "sessionFull" | "bookingSeatsFull";

/** Why one more CONFIRMED booking is refused, or null when a seat is free. */
export function bookingSeatError(
  usage: SessionSeatUsage,
  cap: number,
  maxBookingSeats: number | null,
): BookingSeatError | null {
  if (isAtCapacity(sessionSeatsUsed(usage), cap)) return "sessionFull";
  if (maxBookingSeats !== null && usage.confirmedBookings >= maxBookingSeats) return "bookingSeatsFull";
  return null;
}

/** A session's seats as a student sees them: a status, never a number (like F5's `seatStatus`). */
export function bookingSeatStatus(
  usage: SessionSeatUsage,
  cap: number,
  maxBookingSeats: number | null,
): SeatStatus {
  if (bookingSeatError(usage, cap, maxBookingSeats)) return "full";
  const left = [
    cap > 0 ? cap - sessionSeatsUsed(usage) : Infinity,
    maxBookingSeats !== null ? maxBookingSeats - usage.confirmedBookings : Infinity,
  ];
  return Math.min(...left) <= FEW_SEATS_LEFT ? "few" : "open";
}

/**
 * Enrolment takes a seat in every future session (F6): one more enrolment is
 * refused on a session where `activeEnrollments + 1 + confirmedBookings`
 * exceeds the seat limit. Walk-ins are not counted here — they are on the day.
 */
export function enrolmentOverflowsSession(
  activeEnrollments: number,
  confirmedBookings: number,
  cap: number,
): boolean {
  return cap > 0 && activeEnrollments + 1 + confirmedBookings > cap;
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
