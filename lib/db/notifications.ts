import type {
  EnrollmentStatus,
  Notification,
  NotificationKind,
  Prisma,
  PrismaClient,
  Reservation,
  SessionBooking,
  SessionBookingStatus,
} from "@prisma/client";

// Relative imports on purpose — `npm run check:notifications` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/reservations.ts and lib/db/student-portal.ts).
import { REQUESTER_KINDS, dedupeKeys, isIdsOnlyPayload } from "../notifications/kinds.ts";
import { queueNotificationEmails } from "../notify/email.ts";
import { sessionLabelSelect } from "../session-label.ts";
import { ACCESSIBLE_CENTER } from "./platform.ts";
import { scopedWhere } from "./tenant-scope.ts";

/**
 * The in-app inbox (W1, D-W12). Three jobs, one module:
 *
 * 1. **Write** a notice in the transaction of the event that causes it
 *    (`notify`, and the four producers below). A rolled-back event leaves no
 *    row. `(userId, dedupeKey)` is unique and the write skips duplicates, so a
 *    producer that fires twice writes one notice. No cron, no queue, no
 *    realtime: the bell's count is read on the next navigation.
 * 2. **Read** a person's own notices — `userId` = the signed-in person, the
 *    identity-scoping the student's own reservations use (`lib/db/
 *    student-portal.ts`), never a branch's rows. Every read re-checks access
 *    (`visibleWhere`): a notice whose branch the reader no longer reaches is
 *    hidden, never deleted (`lib/notifications/kinds.ts`, `audience`).
 * 3. **Mark read** — one, or all the reader can see.
 *
 * Rows carry ids only (D-20): the text is rendered at read time, and the names
 * it needs are loaded then through per-branch scoped reads
 * (`loadNotificationSubjects`), so a rename shows and nothing personal is
 * copied. Parents are not notified in v1, and nothing is ever pruned (both
 * backlog).
 */

type Db = PrismaClient | Prisma.TransactionClient;

const ACTIVE_ENROLLMENT: EnrollmentStatus = "ACTIVE";
const CONFIRMED_BOOKING: SessionBookingStatus = "CONFIRMED";

export type NotificationInput = {
  userId: string;
  kind: NotificationKind;
  /** The branch the notice concerns — its access re-check. */
  centerId: string | null;
  payload: Record<string, string>;
  dedupeKey: string;
};

export class NotificationPayloadError extends Error {
  constructor(kind: NotificationKind) {
    super(`Notification payload for ${kind} must hold exactly its ids (D-W12) — never a name or text.`);
    this.name = "NotificationPayloadError";
  }
}

/**
 * Writes notices in the caller's transaction. Pass the event's own `tx`: the
 * notice commits with the event or not at all. A payload that is not exactly
 * its kind's ids is refused before the database's CHECK sees it.
 */
export async function notify(tx: Prisma.TransactionClient, inputs: NotificationInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  for (const input of inputs) {
    if (!isIdsOnlyPayload(input.kind, input.payload)) throw new NotificationPayloadError(input.kind);
  }
  const { count } = await tx.notification.createMany({
    data: inputs.map((input) => ({
      userId: input.userId,
      kind: input.kind,
      centerId: input.centerId,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
    })),
    skipDuplicates: true,
  });
  // The email hook point (EMAIL_ENABLED, off): nothing is sent.
  queueNotificationEmails(inputs);
  return count;
}

// ── Producers (v1) ──────────────────────────────────────────────────────────

/** A class-enrolment request approved or declined — the requester is told. */
export function notifyReservationResolved(
  tx: Prisma.TransactionClient,
  reservation: Pick<Reservation, "id" | "centerId" | "classGroupId" | "studentId" | "requestedAt">,
  outcome: "approved" | "declined",
): Promise<number> {
  return notify(tx, [
    {
      userId: reservation.studentId,
      kind: outcome === "approved" ? "ENROLLMENT_APPROVED" : "ENROLLMENT_DECLINED",
      centerId: reservation.centerId,
      payload: { reservationId: reservation.id, classGroupId: reservation.classGroupId },
      dedupeKey: dedupeKeys.reservation(outcome, reservation.id, reservation.requestedAt),
    },
  ]);
}

/** A single-session booking (F6) approved or declined — the requester is told. */
export function notifyBookingResolved(
  tx: Prisma.TransactionClient,
  booking: Pick<SessionBooking, "id" | "centerId" | "sessionId" | "studentId" | "requestedAt">,
  outcome: "approved" | "declined",
): Promise<number> {
  return notify(tx, [
    {
      userId: booking.studentId,
      kind: outcome === "approved" ? "BOOKING_APPROVED" : "BOOKING_DECLINED",
      centerId: booking.centerId,
      payload: { bookingId: booking.id, sessionId: booking.sessionId },
      dedupeKey: dedupeKeys.booking(outcome, booking.id, booking.requestedAt),
    },
  ]);
}

/**
 * Who a session's change reaches: each student with an ACTIVE enrolment in
 * its class, and each student with a CONFIRMED booking on it. Read before the
 * caller cancels the bookings (`cancelSessionBookings`), in its transaction.
 * A one-time session has no class, so only its bookers (R5 — it has none).
 */
async function sessionAudience(
  tx: Prisma.TransactionClient,
  centerId: string,
  sessionId: string,
): Promise<string[]> {
  const session = await tx.session.findFirst({
    where: scopedWhere(centerId, { id: sessionId }),
    select: { classGroupId: true },
  });
  if (!session) return [];
  const [enrolled, booked] = await Promise.all([
    session.classGroupId
      ? tx.enrollment.findMany({
          where: scopedWhere(centerId, { classGroupId: session.classGroupId, status: ACTIVE_ENROLLMENT }),
          select: { studentProfile: { select: { userId: true } } },
        })
      : Promise.resolve([]),
    tx.sessionBooking.findMany({
      where: scopedWhere(centerId, { sessionId, status: CONFIRMED_BOOKING }),
      select: { studentId: true },
    }),
  ]);
  return [
    ...new Set([
      ...enrolled.map((row) => row.studentProfile.userId),
      ...booked.map((row) => row.studentId),
    ]),
  ];
}

/** A session cancelled (one cancel, a branch pause, a class deactivation — all `cancelSession`). */
export async function notifySessionCancelled(
  tx: Prisma.TransactionClient,
  centerId: string,
  sessionId: string,
): Promise<number> {
  const audience = await sessionAudience(tx, centerId, sessionId);
  return notify(
    tx,
    audience.map((userId) => ({
      userId,
      kind: "SESSION_CANCELLED" as const,
      centerId,
      payload: { sessionId },
      dedupeKey: dedupeKeys.sessionCancelled(sessionId),
    })),
  );
}

/** A session moved — the notice names the original (old time) and its replacement (new time). */
export async function notifySessionRescheduled(
  tx: Prisma.TransactionClient,
  centerId: string,
  sessionId: string,
  newSessionId: string,
): Promise<number> {
  const audience = await sessionAudience(tx, centerId, sessionId);
  return notify(
    tx,
    audience.map((userId) => ({
      userId,
      kind: "SESSION_RESCHEDULED" as const,
      centerId,
      payload: { sessionId, newSessionId },
      dedupeKey: dedupeKeys.sessionRescheduled(sessionId),
    })),
  );
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * What the reader reaches right now: the branches of their relations
 * (`resolveCenterRelations` — active memberships and student profiles at
 * accessible branches). Resolved per request by the caller, so a membership
 * that ended, a deleted branch or a suspended one hides its notices on the
 * very next read.
 */
export type NotificationReach = { relationCenterIds: string[] };

/** The reader's own notices that pass the access re-check — one `where`, every read. */
export function visibleWhere(userId: string, reach: NotificationReach): Prisma.NotificationWhereInput {
  return {
    userId,
    OR: [
      { centerId: null },
      { centerId: { in: reach.relationCenterIds } },
      { kind: { in: REQUESTER_KINDS }, center: ACCESSIBLE_CENTER },
    ],
  };
}

export function countUnread(db: Db, userId: string, reach: NotificationReach): Promise<number> {
  return db.notification.count({ where: { ...visibleWhere(userId, reach), readAt: null } });
}

export async function listNotifications(
  db: Db,
  userId: string,
  reach: NotificationReach,
  page: { skip: number; take: number },
): Promise<{ rows: Notification[]; total: number }> {
  const where = visibleWhere(userId, reach);
  const [rows, total] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: page.skip,
      take: page.take,
    }),
    db.notification.count({ where }),
  ]);
  return { rows, total };
}

/**
 * Opens one notice: marks it read (once) and returns it, or null when it is
 * not the reader's or not visible to them — another person's id, or a hidden
 * one, is "not found" and stays untouched.
 */
export async function markNotificationRead(
  db: Db,
  userId: string,
  reach: NotificationReach,
  id: string,
  now: Date = new Date(),
): Promise<Notification | null> {
  const row = await db.notification.findFirst({ where: { AND: [visibleWhere(userId, reach), { id }] } });
  if (!row) return null;
  if (row.readAt) return row;
  await db.notification.updateMany({ where: { id: row.id, userId, readAt: null }, data: { readAt: now } });
  return { ...row, readAt: now };
}

/** "Mark all as read" — every unread notice the reader can see (hidden ones are left alone). */
export async function markAllNotificationsRead(
  db: Db,
  userId: string,
  reach: NotificationReach,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await db.notification.updateMany({
    where: { AND: [visibleWhere(userId, reach), { readAt: null }] },
    data: { readAt: now },
  });
  return count;
}

// ── What the text names (read time) ─────────────────────────────────────────

/** A session's label source and slot, as `lib/session-label.ts` reads it. */
export type NotificationSession = {
  id: string;
  date: Date;
  startTime: string;
  endTime: string;
} & Prisma.SessionGetPayload<{ select: ReturnType<typeof sessionLabelSelect> }>;

export type NotificationClass = Prisma.ClassGroupGetPayload<{
  select: { id: true; subject: ReturnType<typeof sessionLabelSelect>["subject"]; grade: ReturnType<typeof sessionLabelSelect>["grade"] };
}>;

export type NotificationSubjects = {
  branches: Map<string, { name: string; nameEn: string | null }>;
  classes: Map<string, NotificationClass>;
  sessions: Map<string, NotificationSession>;
};

/**
 * The current names a page of notices needs, loaded from their ids: the
 * branch, the class (catalog labels with that branch's own rename) and the
 * sessions (label and slot). One read per branch per entity — a union of
 * per-branch scoped reads (CLAUDE.md rule 1), never one `where` across
 * branches. Only rows the caller already read through `visibleWhere` are
 * passed in, so nothing here names what the reader could not open. A row
 * whose entity is gone simply has nothing in the map; the text falls back.
 */
export async function loadNotificationSubjects(
  db: Db,
  rows: readonly Pick<Notification, "kind" | "centerId" | "payload">[],
): Promise<NotificationSubjects> {
  const byCenter = new Map<string, { classIds: Set<string>; sessionIds: Set<string> }>();
  for (const row of rows) {
    if (!row.centerId || !isIdsOnlyPayload(row.kind, row.payload)) continue;
    const entry = byCenter.get(row.centerId) ?? { classIds: new Set<string>(), sessionIds: new Set<string>() };
    const payload = row.payload;
    if (payload.classGroupId) entry.classIds.add(payload.classGroupId);
    for (const key of ["sessionId", "newSessionId"] as const) {
      if (payload[key]) entry.sessionIds.add(payload[key]);
    }
    byCenter.set(row.centerId, entry);
  }

  const centerIds = [...byCenter.keys()];
  const [branches, perCenter] = await Promise.all([
    centerIds.length
      ? db.center.findMany({ where: { id: { in: centerIds } }, select: { id: true, name: true, nameEn: true } })
      : Promise.resolve([]),
    Promise.all(
      [...byCenter.entries()].map(async ([centerId, wanted]) => {
        const label = sessionLabelSelect(centerId);
        const [classes, sessions] = await Promise.all([
          wanted.classIds.size
            ? db.classGroup.findMany({
                where: scopedWhere(centerId, { id: { in: [...wanted.classIds] } }),
                select: { id: true, subject: label.subject, grade: label.grade },
              })
            : Promise.resolve([]),
          wanted.sessionIds.size
            ? db.session.findMany({
                where: scopedWhere(centerId, { id: { in: [...wanted.sessionIds] } }),
                select: { id: true, date: true, startTime: true, endTime: true, ...label },
              })
            : Promise.resolve([]),
        ]);
        return { classes, sessions };
      }),
    ),
  ]);

  return {
    branches: new Map(branches.map((branch) => [branch.id, { name: branch.name, nameEn: branch.nameEn }])),
    classes: new Map(perCenter.flatMap((entry) => entry.classes.map((row) => [row.id, row] as const))),
    sessions: new Map(perCenter.flatMap((entry) => entry.sessions.map((row) => [row.id, row] as const))),
  };
}
