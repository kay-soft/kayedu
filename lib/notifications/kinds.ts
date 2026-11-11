import type { AssessmentType, NotificationKind } from "@prisma/client";

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
 *  - `invitation` (W8b, D-W39) — a PERSONAL workspace's invitation to this
 *    account: visible only while the reader holds a PENDING invitation from
 *    that live workspace (`NotificationReach.invitationCenterIds`). Accepted,
 *    declined or cancelled, it is hidden, never deleted.
 *
 * W8b also lets the two session kinds reach a student through a **linked
 * workspace profile** (`NotificationReach.workspaceCenterIds`). W9 (D-W42):
 * the assessment kinds reach that profile too, through the reader's student
 * centres (`NotificationReach.studentCenterIds`) and the assessment re-check.
 */
export type NotificationAudience = "relation" | "requester" | "invitation";

type KindSpec = {
  /** The payload's keys — every value an id (a uuid). */
  ids: readonly string[];
  audience: NotificationAudience;
  /** Locale-less deep link (ROUTES). W1's links name a page; an assessment notice names its row. */
  href: (payload: Record<string, string>) => string;
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
  // W3b (D-W32): the re-check is `assessmentNoticeHidden`, on top of `relation`.
  ASSESSMENT_PUBLISHED: {
    ids: ["assessmentId"],
    audience: "relation",
    href: (payload) => ROUTES.studentAssessment(payload.assessmentId),
  },
  ASSESSMENT_EXTENDED: {
    ids: ["assessmentId"],
    audience: "relation",
    href: (payload) => ROUTES.studentAssessment(payload.assessmentId),
  },
  ASSESSMENT_OPENS_SOON: {
    ids: ["assessmentId"],
    audience: "relation",
    href: (payload) => ROUTES.studentAssessment(payload.assessmentId),
  },
  ASSESSMENT_DUE_SOON: {
    ids: ["assessmentId"],
    audience: "relation",
    href: (payload) => ROUTES.studentAssessment(payload.assessmentId),
  },
  // W8b (D-W39 item 5): written with the invitation, to the matched account.
  // The hub carries the card with Confirm and Cancel, and stays open while one
  // is pending (it does not skip to a single experience).
  WORKSPACE_INVITATION: {
    ids: ["invitationId"],
    audience: "invitation",
    href: () => ROUTES.selectCenter,
  },
} as const satisfies Record<NotificationKind, KindSpec>;

export const NOTIFICATION_KIND_LIST = Object.keys(NOTIFICATION_KINDS) as NotificationKind[];

/** The kinds a reader keeps seeing while the branch is accessible, relation or not. */
export const REQUESTER_KINDS = NOTIFICATION_KIND_LIST.filter(
  (kind) => NOTIFICATION_KINDS[kind].audience === "requester",
);

/** W8b: the session kinds a linked workspace profile reaches (W9: the assessment kinds reach it through `studentCenterIds`). */
export const WORKSPACE_SESSION_KINDS = [
  "SESSION_CANCELLED",
  "SESSION_RESCHEDULED",
] as const satisfies readonly NotificationKind[];

/** Every notice about an exam or homework (W3b, D-W32): only a student at that branch ever sees one. */
export const ASSESSMENT_NOTICE_KINDS = [
  "ASSESSMENT_PUBLISHED",
  "ASSESSMENT_EXTENDED",
  "ASSESSMENT_OPENS_SOON",
  "ASSESSMENT_DUE_SOON",
] as const satisfies readonly NotificationKind[];

/** The two computed on read; hidden once the student has a final attempt. */
export const ASSESSMENT_SOON_KINDS = [
  "ASSESSMENT_OPENS_SOON",
  "ASSESSMENT_DUE_SOON",
] as const satisfies readonly NotificationKind[];

export type AssessmentSoonKind = (typeof ASSESSMENT_SOON_KINDS)[number];

/** The one constant behind both "soon" notices (D-W32). */
export const ASSESSMENT_SOON = {
  OPENS_SOON_MINUTES: 60,
  DUE_SOON_HOURS: 24,
} as const;

const MINUTE_MS = 60_000;
const OPENS_SOON_MS = ASSESSMENT_SOON.OPENS_SOON_MINUTES * MINUTE_MS;
const DUE_SOON_MS = ASSESSMENT_SOON.DUE_SOON_HOURS * 60 * MINUTE_MS;

/** The latest moment each "soon" notice reaches, for the query's indexed range (`now` is exclusive). */
export function assessmentSoonBounds(now: Date): { opensBy: Date; dueBy: Date } {
  return {
    opensBy: new Date(now.getTime() + OPENS_SOON_MS),
    dueBy: new Date(now.getTime() + DUE_SOON_MS),
  };
}

/**
 * Which "soon" notice this assessment is due at `now`, if any: an exam still
 * to open within the hour, a homework still to close within a day. The moment
 * itself counts as gone (it has opened, or closed), and the far edge counts as in.
 */
export function assessmentSoonNotice(
  assessment: { type: AssessmentType; windowStart: Date | null; deadline: Date | null },
  now: Date,
): { kind: AssessmentSoonKind; at: Date } | null {
  const at = assessment.type === "EXAM" ? assessment.windowStart : assessment.deadline;
  if (!at) return null;
  const left = at.getTime() - now.getTime();
  if (left <= 0) return null;
  if (assessment.type === "EXAM") return left <= OPENS_SOON_MS ? { kind: "ASSESSMENT_OPENS_SOON", at } : null;
  return left <= DUE_SOON_MS ? { kind: "ASSESSMENT_DUE_SOON", at } : null;
}

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
  if (!isIdsOnlyPayload(kind, payload)) return ROUTES.studentSchedule;
  const spec: KindSpec = NOTIFICATION_KINDS[kind];
  return spec.href(payload);
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
  // W8b: one notice per invitation row ("Invite again" writes a new row).
  workspaceInvitation: (invitationId: string) => `workspace-invitation:${invitationId}`,
  // W3b: every assessment key opens with this prefix, which is how deleting an
  // assessment finds its notices. Republishing and each new end time are new notices.
  assessmentPrefix: (assessmentId: string) => `assessment:${assessmentId}:`,
  assessmentPublished: (assessmentId: string, publishedAt: Date) =>
    `assessment:${assessmentId}:published:${publishedAt.getTime()}`,
  assessmentExtended: (assessmentId: string, newEnd: Date) => `assessment:${assessmentId}:extended:${newEnd.getTime()}`,
  assessmentSoon: (assessmentId: string, kind: AssessmentSoonKind, at: Date) =>
    `assessment:${assessmentId}:${kind}:${at.getTime()}`,
};
