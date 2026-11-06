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
import { finalisationDue } from "../assessments.ts";
import {
  ASSESSMENT_NOTICE_KINDS,
  ASSESSMENT_SOON_KINDS,
  REQUESTER_KINDS,
  assessmentSoonBounds,
  assessmentSoonNotice,
  dedupeKeys,
  isIdsOnlyPayload,
} from "../notifications/kinds.ts";
import { queueNotificationEmails } from "../notify/email.ts";
import { centreTimeZone } from "../scheduling.ts";
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
 *
 * W3b adds the assessment notices (D-W32): two written by publish and extend,
 * two computed on read (`syncAssessmentSoonNotices`), and a further re-check
 * (`hiddenAssessmentNoticeIds`), since the row's only link to its assessment is
 * an id in the payload.
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

// ── Assessment notices (W3b, D-W32) ─────────────────────────────────────────

/** Each ACTIVE enrolled student of an active class. */
async function enrolledInClass(tx: Db, centerId: string, classGroupId: string) {
  return tx.enrollment.findMany({
    where: scopedWhere(centerId, { classGroupId, status: ACTIVE_ENROLLMENT, classGroup: { active: true } }),
    select: { studentProfileId: true, studentProfile: { select: { userId: true } } },
  });
}

type AssessmentRef = { id: string; centerId: string; classGroupId: string };

/** Published: every student enrolled at that moment. In the publish transaction. */
export async function notifyAssessmentPublished(
  tx: Prisma.TransactionClient,
  assessment: AssessmentRef,
  publishedAt: Date,
): Promise<number> {
  const enrolled = await enrolledInClass(tx, assessment.centerId, assessment.classGroupId);
  return notify(
    tx,
    [...new Set(enrolled.map((row) => row.studentProfile.userId))].map((userId) => ({
      userId,
      kind: "ASSESSMENT_PUBLISHED" as const,
      centerId: assessment.centerId,
      payload: { assessmentId: assessment.id },
      dedupeKey: dedupeKeys.assessmentPublished(assessment.id, publishedAt),
    })),
  );
}

/**
 * Extended: every eligible student with no final attempt. In the extend
 * transaction, after it finalised what was already overdue, so an attempt that
 * ended under the old time is not told about the new one.
 */
export async function notifyAssessmentExtended(
  tx: Prisma.TransactionClient,
  assessment: AssessmentRef,
  newEnd: Date,
): Promise<number> {
  const [enrolled, finished] = await Promise.all([
    enrolledInClass(tx, assessment.centerId, assessment.classGroupId),
    tx.assessmentAttempt.findMany({
      where: scopedWhere(assessment.centerId, { assessmentId: assessment.id, submittedAt: { not: null } }),
      select: { studentProfileId: true },
    }),
  ]);
  const done = new Set(finished.map((row) => row.studentProfileId));
  const recipients = enrolled.filter((row) => !done.has(row.studentProfileId)).map((row) => row.studentProfile.userId);
  return notify(
    tx,
    [...new Set(recipients)].map((userId) => ({
      userId,
      kind: "ASSESSMENT_EXTENDED" as const,
      centerId: assessment.centerId,
      payload: { assessmentId: assessment.id },
      dedupeKey: dedupeKeys.assessmentExtended(assessment.id, newEnd),
    })),
  );
}

/** Deleting an assessment deletes its notices, in the delete's transaction (every kind, every recipient). */
export async function deleteAssessmentNotices(
  tx: Prisma.TransactionClient,
  centerId: string,
  assessmentId: string,
): Promise<number> {
  const { count } = await tx.notification.deleteMany({
    where: scopedWhere(centerId, { dedupeKey: { startsWith: dedupeKeys.assessmentPrefix(assessmentId) } }),
  });
  return count;
}

/** The read stays bounded even on bad data; no real student has this many in a day at one branch. */
const SOON_ROWS_PER_BRANCH = 50;

/** Final now, or already past its end and only waiting to be read (D-W10). Nothing is written here. */
function attemptIsFinal(
  timing: Parameters<typeof finalisationDue>[0],
  attempt: { startedAt: Date; lastSeenAt: Date; submittedAt: Date | null },
  now: Date,
): boolean {
  return attempt.submittedAt !== null || finalisationDue(timing, attempt, now) !== null;
}

/**
 * The "soon" notices, computed on read (D-W12, rule 12: no cron, no queue): one
 * indexed, bounded read per branch this person is a student at (a union of
 * per-branch reads, rule 1), then an insert of whatever is missing. The unique
 * `(userId, dedupeKey)` with ON CONFLICT DO NOTHING makes two concurrent reads
 * one row. Only keys not already there reach `notify`, so its email hook is not
 * handed the same notice on every navigation.
 */
export async function syncAssessmentSoonNotices(
  db: Db,
  userId: string,
  studentCenterIds: readonly string[],
  now: Date,
): Promise<number> {
  const { opensBy, dueBy } = assessmentSoonBounds(now);
  const perBranch = await Promise.all(
    studentCenterIds.map(async (centerId) => {
      const rows = await db.assessment.findMany({
        where: scopedWhere(centerId, {
          status: "PUBLISHED" as const,
          classGroup: {
            active: true,
            enrollments: { some: { status: ACTIVE_ENROLLMENT, studentProfile: { userId, active: true } } },
          },
          OR: [
            { type: "EXAM" as const, windowStart: { gt: now, lte: opensBy } },
            { type: "HOMEWORK" as const, deadline: { gt: now, lte: dueBy } },
          ],
        }),
        select: {
          id: true,
          type: true,
          windowStart: true,
          windowEnd: true,
          deadline: true,
          durationMinutes: true,
          oneSitting: true,
          attempts: {
            where: { studentProfile: { userId } },
            select: { startedAt: true, lastSeenAt: true, submittedAt: true },
          },
        },
        orderBy: { id: "asc" },
        take: SOON_ROWS_PER_BRANCH,
      });
      return rows.flatMap((row): NotificationInput[] => {
        const soon = assessmentSoonNotice(row, now);
        if (!soon) return [];
        // An exam: no attempt at all. A homework: no final attempt.
        const attempt = row.attempts[0] ?? null;
        const blocked = soon.kind === "ASSESSMENT_OPENS_SOON" ? attempt !== null : attempt !== null && attemptIsFinal(row, attempt, now);
        if (blocked) return [];
        return [
          {
            userId,
            kind: soon.kind,
            centerId,
            payload: { assessmentId: row.id },
            dedupeKey: dedupeKeys.assessmentSoon(row.id, soon.kind, soon.at),
          },
        ];
      });
    }),
  );
  const wanted = perBranch.flat();
  if (wanted.length === 0) return 0;
  const existing = await db.notification.findMany({
    where: { userId, dedupeKey: { in: wanted.map((row) => row.dedupeKey) } },
    select: { dedupeKey: true },
  });
  const have = new Set(existing.map((row) => row.dedupeKey));
  return notify(db as Prisma.TransactionClient, wanted.filter((row) => !have.has(row.dedupeKey)));
}

/** What the re-check needs to know about one assessment, for one student. */
export type AssessmentNoticeSubject = Parameters<typeof finalisationDue>[0] & {
  id: string;
  status: "DRAFT" | "PUBLISHED";
  publishedAt: Date | null;
  classActive: boolean;
  /** An ACTIVE enrolment in the class, on an active profile. */
  enrolled: boolean;
  attempt: { startedAt: Date; lastSeenAt: Date; submittedAt: Date | null } | null;
};

/**
 * The assessment half of the read-time re-check (D-W32). Hidden, never deleted:
 * no longer PUBLISHED, the class inactive, or the enrolment gone. A "soon" notice
 * also hides once the attempt is final. A PUBLISHED notice from an earlier publish
 * stays hidden after a republish, so one publish rings once.
 */
export function assessmentNoticeHidden(
  notice: Pick<Notification, "kind" | "dedupeKey">,
  assessment: AssessmentNoticeSubject | undefined,
  now: Date,
): boolean {
  if (!assessment) return true;
  if (assessment.status !== "PUBLISHED" || !assessment.classActive || !assessment.enrolled) return true;
  if (
    notice.kind === "ASSESSMENT_PUBLISHED" &&
    (!assessment.publishedAt || notice.dedupeKey !== dedupeKeys.assessmentPublished(assessment.id, assessment.publishedAt))
  ) {
    return true;
  }
  const soon: readonly NotificationKind[] = ASSESSMENT_SOON_KINDS;
  return soon.includes(notice.kind) && assessment.attempt !== null && attemptIsFinal(assessment, assessment.attempt, now);
}

/**
 * The ids of this reader's assessment notices that fail the re-check. One read of
 * their own rows, then one scoped read per branch that has any, never a query
 * across branches (rule 1). `unreadOnly` is the bell's cheap path: its count and
 * "mark all" touch unread rows alone, so read history costs them nothing.
 */
export async function hiddenAssessmentNoticeIds(
  db: Db,
  userId: string,
  studentCenterIds: readonly string[],
  now: Date,
  options: { unreadOnly?: boolean } = {},
): Promise<string[]> {
  if (studentCenterIds.length === 0) return [];
  const notices = await db.notification.findMany({
    where: {
      userId,
      kind: { in: [...ASSESSMENT_NOTICE_KINDS] },
      centerId: { in: [...studentCenterIds] },
      ...(options.unreadOnly ? { readAt: null } : {}),
    },
    select: { id: true, kind: true, centerId: true, dedupeKey: true, payload: true },
  });
  if (notices.length === 0) return [];

  const idsByCenter = new Map<string, Set<string>>();
  for (const notice of notices) {
    if (!notice.centerId || !isIdsOnlyPayload(notice.kind, notice.payload)) continue;
    const ids = idsByCenter.get(notice.centerId) ?? new Set<string>();
    ids.add(notice.payload.assessmentId);
    idsByCenter.set(notice.centerId, ids);
  }

  const perBranch = await Promise.all(
    [...idsByCenter.entries()].map(([centerId, ids]) =>
      db.assessment.findMany({
        where: scopedWhere(centerId, { id: { in: [...ids] } }),
        select: {
          id: true,
          status: true,
          publishedAt: true,
          type: true,
          windowStart: true,
          windowEnd: true,
          deadline: true,
          durationMinutes: true,
          oneSitting: true,
          classGroup: {
            select: {
              active: true,
              enrollments: {
                where: { status: ACTIVE_ENROLLMENT, studentProfile: { userId, active: true } },
                select: { id: true },
                take: 1,
              },
            },
          },
          attempts: {
            where: { studentProfile: { userId } },
            select: { startedAt: true, lastSeenAt: true, submittedAt: true },
            take: 1,
          },
        },
      }),
    ),
  );
  const subjects = new Map<string, AssessmentNoticeSubject>(
    perBranch.flat().map((row) => [
      row.id,
      {
        id: row.id,
        status: row.status,
        publishedAt: row.publishedAt,
        type: row.type,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        deadline: row.deadline,
        durationMinutes: row.durationMinutes,
        oneSitting: row.oneSitting,
        classActive: row.classGroup.active,
        enrolled: row.classGroup.enrollments.length > 0,
        attempt: row.attempts[0] ?? null,
      },
    ]),
  );
  return notices
    .filter((notice) => {
      if (!isIdsOnlyPayload(notice.kind, notice.payload)) return true;
      return assessmentNoticeHidden(notice, subjects.get(notice.payload.assessmentId), now);
    })
    .map((notice) => notice.id);
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * What the reader reaches right now: the branches of their relations
 * (`resolveCenterRelations` — active memberships and student profiles at
 * accessible branches). Resolved per request by the caller, so a membership
 * that ended, a deleted branch or a suspended one hides its notices on the
 * very next read.
 *
 * W3b adds two things for assessment notices (D-W32): the branches where the
 * reader is a **student** (a teacher or a receptionist at the branch reaches
 * none of them, deny by default), and the ids the assessment re-check hid.
 */
export type NotificationReach = {
  relationCenterIds: string[];
  studentCenterIds?: string[];
  hiddenNoticeIds?: string[];
};

/** The reader's own notices that pass the access re-check — one `where`, every read. */
export function visibleWhere(userId: string, reach: NotificationReach): Prisma.NotificationWhereInput {
  const hidden = reach.hiddenNoticeIds ?? [];
  return {
    userId,
    ...(hidden.length > 0 ? { id: { notIn: hidden } } : {}),
    OR: [
      { centerId: null },
      { centerId: { in: reach.relationCenterIds }, kind: { notIn: [...ASSESSMENT_NOTICE_KINDS] } },
      { centerId: { in: reach.studentCenterIds ?? [] }, kind: { in: [...ASSESSMENT_NOTICE_KINDS] } },
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

export type NotificationAssessment = Prisma.AssessmentGetPayload<{
  select: {
    id: true;
    type: true;
    title: true;
    windowStart: true;
    windowEnd: true;
    deadline: true;
    session: { select: { timezone: true } };
    classGroup: {
      select: { subject: ReturnType<typeof sessionLabelSelect>["subject"]; grade: ReturnType<typeof sessionLabelSelect>["grade"] };
    };
  };
}>;

export type NotificationSubjects = {
  /** `timeZone`: what an exam with no session is shown in (D-14, D-W32). */
  branches: Map<string, { name: string; nameEn: string | null; timeZone: string }>;
  classes: Map<string, NotificationClass>;
  sessions: Map<string, NotificationSession>;
  assessments: Map<string, NotificationAssessment>;
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
  const byCenter = new Map<string, { classIds: Set<string>; sessionIds: Set<string>; assessmentIds: Set<string> }>();
  for (const row of rows) {
    if (!row.centerId || !isIdsOnlyPayload(row.kind, row.payload)) continue;
    const entry = byCenter.get(row.centerId) ?? {
      classIds: new Set<string>(),
      sessionIds: new Set<string>(),
      assessmentIds: new Set<string>(),
    };
    const payload = row.payload;
    if (payload.classGroupId) entry.classIds.add(payload.classGroupId);
    if (payload.assessmentId) entry.assessmentIds.add(payload.assessmentId);
    for (const key of ["sessionId", "newSessionId"] as const) {
      if (payload[key]) entry.sessionIds.add(payload[key]);
    }
    byCenter.set(row.centerId, entry);
  }

  const centerIds = [...byCenter.keys()];
  const [branches, perCenter] = await Promise.all([
    centerIds.length
      ? db.center.findMany({
          where: { id: { in: centerIds } },
          select: { id: true, name: true, nameEn: true, settings: { select: { timezone: true } } },
        })
      : Promise.resolve([]),
    Promise.all(
      [...byCenter.entries()].map(async ([centerId, wanted]) => {
        const label = sessionLabelSelect(centerId);
        const [classes, sessions, assessments] = await Promise.all([
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
          // Never a question or a correct mark: the title, the class and the times.
          wanted.assessmentIds.size
            ? db.assessment.findMany({
                where: scopedWhere(centerId, { id: { in: [...wanted.assessmentIds] } }),
                select: {
                  id: true,
                  type: true,
                  title: true,
                  windowStart: true,
                  windowEnd: true,
                  deadline: true,
                  session: { select: { timezone: true } },
                  classGroup: { select: { subject: label.subject, grade: label.grade } },
                },
              })
            : Promise.resolve([]),
        ]);
        return { classes, sessions, assessments };
      }),
    ),
  ]);

  return {
    branches: new Map(
      branches.map((branch) => [
        branch.id,
        { name: branch.name, nameEn: branch.nameEn, timeZone: centreTimeZone(branch.settings) },
      ]),
    ),
    classes: new Map(perCenter.flatMap((entry) => entry.classes.map((row) => [row.id, row] as const))),
    sessions: new Map(perCenter.flatMap((entry) => entry.sessions.map((row) => [row.id, row] as const))),
    assessments: new Map(perCenter.flatMap((entry) => entry.assessments.map((row) => [row.id, row] as const))),
  };
}
