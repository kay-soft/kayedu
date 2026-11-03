import type { NotificationKind } from "@prisma/client";

// Relative import on purpose: `npm run check:notifications` exercises this
// module directly, outside the Next.js runtime (the lib/money.ts reasoning).
import { ROUTES } from "../routes.ts";

/**
 * **The one declaration of every notice kind (W1, D-W12).** For each kind:
 * which ids its payload carries (ids only — never a name, contact or text,
 * the D-20 rule), who may still see it (`audience`, below), and where opening
 * it leads. The text is next-intl's `Notifications.kinds.<KIND>`, rendered
 * at read time from the ids (`lib/notifications/present.ts`), so a rename
 * shows and nothing personal is copied into the row.
 *
 * `audience` is the read-time access re-check (decision 3):
 *  - `relation` — visible while the reader still reaches the notice's branch
 *    (`resolveCenterRelations`: an active membership or student profile at an
 *    accessible branch). A session notice: the student is enrolled or booked
 *    there, so they hold a profile; once it is deactivated, or the branch is
 *    suspended or deleted, the notice is hidden — never deleted.
 *  - `requester` — the reader's own request (a `Reservation` or a
 *    `SessionBooking`), which "My requests" lists by their own id with no
 *    profile needed (a first request that was declined never made one). It
 *    is visible while the branch itself is accessible, and through a relation
 *    there as well.
 */
export type NotificationAudience = "relation" | "requester";

type KindSpec = {
  /** The payload's keys — every value an id (a uuid). */
  ids: readonly string[];
  audience: NotificationAudience;
  /** Locale-less deep link (ROUTES). v1's links name a page, not a row; a later kind may read its payload. */
  href: () => string;
};

export const NOTIFICATION_KINDS = {
  ENROLLMENT_APPROVED: {
    ids: ["reservationId", "classGroupId"],
    audience: "requester",
    // The class's sessions are on the schedule from now on.
    href: () => ROUTES.studentSchedule,
  },
  ENROLLMENT_DECLINED: {
    ids: ["reservationId", "classGroupId"],
    audience: "requester",
    href: () => ROUTES.studentReservations,
  },
  BOOKING_APPROVED: {
    ids: ["bookingId", "sessionId"],
    audience: "requester",
    href: () => `${ROUTES.studentReservations}?tab=bookings`,
  },
  BOOKING_DECLINED: {
    ids: ["bookingId", "sessionId"],
    audience: "requester",
    href: () => `${ROUTES.studentReservations}?tab=bookings`,
  },
  SESSION_CANCELLED: {
    ids: ["sessionId"],
    audience: "relation",
    href: () => ROUTES.studentSchedule,
  },
  SESSION_RESCHEDULED: {
    // The original session (kept, linked) and the one it moved to.
    ids: ["sessionId", "newSessionId"],
    audience: "relation",
    href: () => ROUTES.studentSchedule,
  },
} as const satisfies Record<NotificationKind, KindSpec>;

export const NOTIFICATION_KIND_LIST = Object.keys(NOTIFICATION_KINDS) as NotificationKind[];

/** The kinds a reader keeps seeing while the branch is accessible, relation or not. */
export const REQUESTER_KINDS = NOTIFICATION_KIND_LIST.filter(
  (kind) => NOTIFICATION_KINDS[kind].audience === "requester",
);

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A payload is exactly the kind's ids, each a uuid — the rule the migration's
 * CHECK (`Notification_payload_ids_only_check`) backs up in the database.
 */
export function isIdsOnlyPayload(kind: NotificationKind, payload: unknown): payload is Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const expected: readonly string[] = NOTIFICATION_KINDS[kind].ids;
  const entries = Object.entries(payload);
  return (
    entries.length === expected.length &&
    entries.every(([key, value]) => expected.includes(key) && typeof value === "string" && ID.test(value))
  );
}

/** The deep link a stored notice opens (locale-less). */
export function notificationHref(kind: NotificationKind, payload: unknown): string {
  return isIdsOnlyPayload(kind, payload) ? NOTIFICATION_KINDS[kind].href() : ROUTES.studentSchedule;
}

/**
 * Dedupe keys — one row per (recipient, key), so an event that fires twice
 * writes one notice. A `Reservation` or `SessionBooking` row is reused when
 * the student asks again, so a request's key carries its `requestedAt`: a
 * second real approval is a new notice, a repeated one is not. A session is
 * cancelled once and moved once (it then points at its replacement).
 */
export const dedupeKeys = {
  reservation: (outcome: "approved" | "declined", reservationId: string, requestedAt: Date) =>
    `enrollment-${outcome}:${reservationId}:${requestedAt.getTime()}`,
  booking: (outcome: "approved" | "declined", bookingId: string, requestedAt: Date) =>
    `booking-${outcome}:${bookingId}:${requestedAt.getTime()}`,
  sessionCancelled: (sessionId: string) => `session-cancelled:${sessionId}`,
  sessionRescheduled: (sessionId: string) => `session-rescheduled:${sessionId}`,
};
