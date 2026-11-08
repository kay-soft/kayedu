import type { AttendanceStatus, EnrollmentStatus, Payment, Prisma, PrismaClient, Refund, SessionAttendee } from "@prisma/client";

// Relative imports on purpose: `npm run check:workspaces` runs this module
// directly, outside the Next.js runtime. The client is injected.
import { attendanceDisplay } from "../attendance-rules.ts";
import { changeAttendanceStatus, createAttendance, findAttendee, recheckInAttendee } from "./attendance.ts";
import { writeAuditRow } from "./audit-row.ts";
import { recordPayment, voidPayment, writePaymentRecordAudit, type RecordPaymentResult } from "./payments.ts";
import { WORKSPACE_PAYMENT_METHOD_NAME } from "./platform.ts";
import { refundPayment } from "./refunds.ts";
import {
  closeSession,
  SessionClosedError,
  type SessionClosedReason,
  WRITE_TRANSACTION_OPTIONS,
} from "./session-lifecycle.ts";
import { scopedWhere } from "./tenant-scope.ts";
import {
  authorizeWrite,
  workspaceCan,
  type WorkspaceAccess,
  type WorkspaceAuthError,
  type WorkspaceCapability,
} from "./workspaces.ts";

/**
 * Check-in and payments in a PERSONAL workspace (W8c, D-W23, D-W24, D-W40;
 * docs/02-architecture.md §18). **Thin wrappers over the unchanged branch
 * engine** — `createAttendance`, `recheckInAttendee` and
 * `changeAttendanceStatus` (lib/db/attendance.ts), `recordPayment` and
 * `voidPayment` (lib/db/payments.ts), `refundPayment` (lib/db/refunds.ts) and
 * `closeSession` (lib/db/session-lifecycle.ts). Nothing here computes money:
 * the snapshot, the one-active-payment rule (SEC-05), void ≠ refund (SEC-12),
 * the R2 closure guard and the T5 reset are the engine's, and the split is
 * `lib/money.ts`'s on the forced PERCENTAGE 0 cut (D-W38), so the centre share
 * is 0 and the teacher share is the amount (CLAUDE.md rule 15).
 *
 * What a wrapper adds is only the workspace's authority, re-run from the ids
 * on every call (a direct call can never skip it):
 *
 * - `authorizeWrite` — the workspace resolved for the **actor** (owning it),
 *   `workspaceCan` with `workspace.attendance.manage` (check-in, corrections,
 *   close) or `workspace.payments.manage` (record, void, refund), and
 *   `assertWorkspaceWritable` (premium now, not archived). Reads need none of
 *   it beyond `resolveWorkspaceAccess`.
 * - `teacherUserId` must be the workspace's owner. It is a separate argument
 *   from the actor (D-W40 item 7) so W8d's assistants fit in without
 *   reshaping these signatures; in W8c the actor must be that owner.
 * - **Enrolled students only** (D-W40 item 4): a student with no ACTIVE
 *   enrolment in the session's class is refused (`notEnrolled`) — there are
 *   no drop-ins in a workspace, so a one-time session (no class) takes no
 *   check-in at all.
 * - The payment method is the workspace's one hidden "Cash"
 *   (`WORKSPACE_PAYMENT_METHOD_NAME`), resolved here — never posted.
 *
 * Audit rows are the branches' own (D-W40 item 8): `payment.record`,
 * `payment.void`, `payment.refund`, `attendance.correct` (written by the
 * engine) and `session.close`, ids and amounts only (D-20), on the change's
 * own transaction. A first check-in is not audited, as at a branch.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const ACTIVE: EnrollmentStatus = "ACTIVE";

/** Who acts, and for whom (D-W40 item 7). In W8c both are the owner. */
export type WorkspaceActor = { actorUserId: string; teacherUserId: string };

export type WorkspaceSessionError =
  | WorkspaceAuthError
  | SessionClosedReason
  | "notEnrolled"
  | "alreadyCheckedIn"
  | "notCheckedIn"
  | "reasonRequired"
  | "voidConfirmationRequired";

async function authorize(
  db: Db,
  actor: WorkspaceActor,
  workspaceId: string,
  action: WorkspaceCapability,
  now: Date,
): Promise<{ ok: true; access: WorkspaceAccess } | { ok: false; error: WorkspaceAuthError }> {
  const auth = await authorizeWrite(db, actor.actorUserId, workspaceId, action, now);
  if (!auth.ok) return auth;
  // The teacher named must own this workspace — a swapped teacher id is not-found.
  if (auth.access.ownerUserId !== actor.teacherUserId) return { ok: false, error: "notFound" };
  return auth;
}

/** The workspace's session, by id, or null — scoped by its centre (tenant rule 1). */
function findWorkspaceSession(db: Db, centerId: string, sessionId: string) {
  return db.session.findFirst({
    where: scopedWhere(centerId, { id: sessionId }),
    select: { id: true, classGroupId: true, teacherId: true },
  });
}

/** The workspace's hidden Cash method (D-W40 item 2), or null if it is missing. */
export function workspacePaymentMethod(db: Db, centerId: string) {
  return db.centerPaymentMethod.findFirst({
    where: { centerId, name: WORKSPACE_PAYMENT_METHOD_NAME, active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

// ── Check-in ───────────────────────────────────────────────────────────────

export type WorkspaceCheckInResult =
  | { ok: true; attendee: SessionAttendee }
  | { ok: false; error: WorkspaceSessionError };

/**
 * Checks an enrolled student in (D-W23, D-W40 item 4). The status — PRESENT
 * or LATE — is the engine's, from the clock and the class's late threshold
 * (the settings row's default only when the class has none; R2). A "Not
 * arrived" row (ABSENT on a live session — reset by a void or refund, or
 * corrected to Absent) is checked in again on the same row
 * (`recheckInAttendee`, T5). A checked-in row is `alreadyCheckedIn`.
 */
export async function workspaceCheckIn(
  db: PrismaClient,
  actor: WorkspaceActor,
  workspaceId: string,
  input: { sessionId: string; studentProfileId: string },
  now: Date = new Date(),
): Promise<WorkspaceCheckInResult> {
  const auth = await authorize(db, actor, workspaceId, "workspace.attendance.manage", now);
  if (!auth.ok) return auth;
  const centerId = auth.access.centerId;
  const session = await findWorkspaceSession(db, centerId, input.sessionId);
  if (!session) return { ok: false, error: "notFound" };
  // No drop-ins (D-W40 item 4): an ACTIVE enrolment in this session's class, or nothing.
  const enrollment = session.classGroupId
    ? await db.enrollment.findFirst({
        where: scopedWhere(centerId, {
          classGroupId: session.classGroupId,
          studentProfileId: input.studentProfileId,
          status: ACTIVE,
          studentProfile: { active: true },
        }),
        select: { id: true },
      })
    : null;
  if (!enrollment) return { ok: false, error: "notEnrolled" };

  const existing = await findAttendee(db, centerId, session.id, input.studentProfileId);
  if (existing) {
    if (existing.attendanceStatus !== "ABSENT") return { ok: false, error: "alreadyCheckedIn" };
    const again = await recheckInAttendee(db, { centerId, attendeeId: existing.id, recordedBy: actor.actorUserId }, { now });
    if (!again.ok) return { ok: false, error: again.error === "branchPaused" ? "forbidden" : again.error };
    return { ok: true, attendee: again.attendee };
  }
  try {
    const attendee = await createAttendance(
      db,
      {
        centerId,
        sessionId: session.id,
        studentProfileId: input.studentProfileId,
        enrollmentId: enrollment.id,
        isDropIn: false,
        recordedBy: actor.actorUserId,
      },
      { now },
    );
    return { ok: true, attendee };
  } catch (error) {
    if (error instanceof SessionClosedError) {
      return { ok: false, error: error.reason === "branchPaused" ? "forbidden" : error.reason };
    }
    // Two taps at once: the (session, student) key let one row in.
    if (await findAttendee(db, centerId, session.id, input.studentProfileId)) return { ok: false, error: "alreadyCheckedIn" };
    throw error;
  }
}

// ── Correction (and the Absent switch) ────────────────────────────────────

export type WorkspaceAttendanceChangeResult =
  | { ok: true; attendee: SessionAttendee; voidedPayment: Payment | null }
  | { ok: false; error: WorkspaceSessionError };

/**
 * A changed mark on a checked-in row, live sessions only (R2) — the engine's
 * `changeAttendanceStatus`, with its change row and `attendance.correct`
 * audit. **The Absent switch** on a student holding an active payment voids
 * it in the same transaction (with its `payment.void` row), needs a reason,
 * and needs `workspace.payments.manage` as well — a status change never voids
 * money its actor could not void directly. `confirmVoid: false` (the roster's
 * Absent button, before its dialog) refuses a switch that would void, so a void
 * never happens unannounced; a direct call that omits it is the engine's rule.
 */
export async function workspaceSetAttendance(
  db: PrismaClient,
  actor: WorkspaceActor,
  workspaceId: string,
  input: {
    sessionId: string;
    studentProfileId: string;
    status: AttendanceStatus;
    reason?: string | null;
    confirmVoid?: boolean;
  },
  now: Date = new Date(),
): Promise<WorkspaceAttendanceChangeResult> {
  const auth = await authorize(db, actor, workspaceId, "workspace.attendance.manage", now);
  if (!auth.ok) return auth;
  const centerId = auth.access.centerId;
  const session = await findWorkspaceSession(db, centerId, input.sessionId);
  if (!session) return { ok: false, error: "notFound" };
  const existing = await findAttendee(db, centerId, session.id, input.studentProfileId);
  if (!existing) return { ok: false, error: "notCheckedIn" };
  if (input.status === "ABSENT" && input.confirmVoid === false) {
    const active = await db.payment.count({
      where: scopedWhere(centerId, { sessionAttendeeId: existing.id, voided: false, refunded: false }),
    });
    if (active > 0) return { ok: false, error: "voidConfirmationRequired" };
  }

  const result = await changeAttendanceStatus(
    db,
    {
      centerId,
      attendeeId: existing.id,
      status: input.status,
      changedBy: actor.actorUserId,
      reason: input.reason ?? null,
      mayVoidPayment: workspaceCan({ workspace: auth.access }, "workspace.payments.manage"),
    },
    { now },
  );
  if (!result.ok) {
    if (result.error === "voidNotPermitted") return { ok: false, error: "forbidden" };
    return { ok: false, error: result.error };
  }
  return { ok: true, attendee: result.attendee, voidedPayment: result.voidedPayment };
}

// ── Money ──────────────────────────────────────────────────────────────────

export type WorkspaceRecordPaymentResult =
  | { ok: true; payment: Payment }
  | { ok: false; error: WorkspaceAuthError | Extract<RecordPaymentResult, { ok: false }>["error"] };

/**
 * Records the payment of a checked-in (PRESENT/LATE) student — the engine's
 * `recordPayment`, unchanged: the amount is the session's price as read under
 * the locks (no amount is ever posted), the cut is the session's or class's
 * PERCENTAGE 0, frozen with the method's label. Audited `payment.record` on
 * the same transaction. Authority is re-checked inside that transaction.
 */
export async function workspaceRecordPayment(
  db: PrismaClient,
  actor: WorkspaceActor,
  workspaceId: string,
  input: { attendeeId: string },
  now: Date = new Date(),
): Promise<WorkspaceRecordPaymentResult> {
  return db.$transaction(async (tx): Promise<WorkspaceRecordPaymentResult> => {
    const auth = await authorize(tx, actor, workspaceId, "workspace.payments.manage", now);
    if (!auth.ok) return auth;
    const centerId = auth.access.centerId;
    const method = await workspacePaymentMethod(tx, centerId);
    if (!method) return { ok: false, error: "invalidMethod" };
    const recorded = await recordPayment(tx, centerId, input.attendeeId, method.id, actor.actorUserId, { now });
    if (recorded.ok) await writePaymentRecordAudit(tx, centerId, actor.actorUserId, recorded.payment);
    return recorded;
  }, WRITE_TRANSACTION_OPTIONS);
}

export type WorkspaceReversalResult =
  | { ok: true; payment: Payment; refund: Refund | null }
  | {
      ok: false;
      error: WorkspaceAuthError | "notFound" | "alreadyVoided" | "alreadyRefunded" | "reasonRequired" | SessionClosedReason;
    };

/**
 * Voids a payment (it should never have stood) — the engine's `voidPayment`,
 * reason required, live sessions only, and on a live session the student goes
 * back to "Not arrived" (T5). Audited `payment.void` with the branches' shape.
 */
export async function workspaceVoidPayment(
  db: PrismaClient,
  actor: WorkspaceActor,
  workspaceId: string,
  input: { paymentId: string; reason: string },
  now: Date = new Date(),
): Promise<WorkspaceReversalResult> {
  return db.$transaction(async (tx): Promise<WorkspaceReversalResult> => {
    const auth = await authorize(tx, actor, workspaceId, "workspace.payments.manage", now);
    if (!auth.ok) return auth;
    const centerId = auth.access.centerId;
    const voided = await voidPayment(tx, centerId, input.paymentId, input.reason, actor.actorUserId, { now });
    if (!voided.ok) return voided;
    await writeAuditRow(tx, {
      centerId,
      actorUserId: actor.actorUserId,
      action: "payment.void",
      entityType: "Payment",
      entityId: voided.payment.id,
      before: { amount: voided.payment.amount, voided: false },
      after: { voided: true, sessionId: voided.payment.sessionId },
    });
    return { ok: true, payment: voided.payment, refund: null };
  }, WRITE_TRANSACTION_OPTIONS);
}

/**
 * Refunds a payment in full, in cash (the money went back) — the engine's
 * `refundPayment`: the original row's money fields untouched, a `Refund` row
 * reversing its frozen amount and both shares, no balance anywhere, and the
 * T5 reset on a live session. Audited `payment.refund` with the branches' shape.
 */
export async function workspaceRefundPayment(
  db: PrismaClient,
  actor: WorkspaceActor,
  workspaceId: string,
  input: { paymentId: string; reason: string },
  now: Date = new Date(),
): Promise<WorkspaceReversalResult> {
  return db.$transaction(async (tx): Promise<WorkspaceReversalResult> => {
    const auth = await authorize(tx, actor, workspaceId, "workspace.payments.manage", now);
    if (!auth.ok) return auth;
    const centerId = auth.access.centerId;
    const refunded = await refundPayment(tx, centerId, input.paymentId, input.reason, actor.actorUserId, { now });
    if (!refunded.ok) return refunded;
    await writeAuditRow(tx, {
      centerId,
      actorUserId: actor.actorUserId,
      action: "payment.refund",
      entityType: "Payment",
      entityId: refunded.payment.id,
      before: { refunded: false },
      after: {
        refunded: true,
        refundId: refunded.refund.id,
        sessionId: refunded.payment.sessionId,
        amount: refunded.refund.amount,
        centerShareReversed: refunded.refund.centerShareReversed,
        teacherShareReversed: refunded.refund.teacherShareReversed,
      },
    });
    return { ok: true, payment: refunded.payment, refund: refunded.refund };
  }, WRITE_TRANSACTION_OPTIONS);
}

// ── Close ──────────────────────────────────────────────────────────────────

export type WorkspaceCloseResult =
  | { ok: true; absentCreated: number }
  | { ok: false; error: WorkspaceAuthError | "sessionCancelled" | "sessionRescheduled" | "alreadyClosed" | "notStarted" };

/**
 * "End session" (R2, D-W40 item 5) — the engine's `closeSession`: refused
 * before the session starts, on a cancelled or rescheduled one and on one
 * already closed; every enrolled student with no roster row becomes ABSENT.
 * Irreversible: the closed session refuses every write but none is offered
 * (void and refund are refused on a closed session too). Audited
 * `session.close` on the close's own transaction. The end-of-day lazy close
 * is the engine's and runs on any read or write, premium or not (it is the
 * system's close, not the teacher's).
 */
export async function workspaceCloseSession(
  db: PrismaClient,
  actor: WorkspaceActor,
  workspaceId: string,
  input: { sessionId: string },
  now: Date = new Date(),
): Promise<WorkspaceCloseResult> {
  return db.$transaction(async (tx): Promise<WorkspaceCloseResult> => {
    const auth = await authorize(tx, actor, workspaceId, "workspace.attendance.manage", now);
    if (!auth.ok) return auth;
    const centerId = auth.access.centerId;
    const result = await closeSession(tx, centerId, input.sessionId, { closedBy: actor.actorUserId, now });
    if (!result.ok) return { ok: false, error: result.error };
    await writeAuditRow(tx, {
      centerId,
      actorUserId: actor.actorUserId,
      action: "session.close",
      entityType: "Session",
      entityId: input.sessionId,
      before: { closedAt: null },
      after: {
        status: result.session.status,
        closeMode: result.session.closeMode,
        closedAt: result.session.closedAt,
        absentCreated: result.absentCreated,
      },
    });
    return { ok: true, absentCreated: result.absentCreated };
  }, WRITE_TRANSACTION_OPTIONS);
}

// ── Reads ──────────────────────────────────────────────────────────────────

const CATALOG_NAME = { select: { nameAr: true, nameEn: true } } as const;

/** One workspace session, as its page shows it, or null when it is not this workspace's. */
export function workspaceSessionDetail(db: Db, centerId: string, sessionId: string) {
  return db.session.findFirst({
    where: scopedWhere(centerId, { id: sessionId }),
    select: {
      id: true,
      date: true,
      startTime: true,
      endTime: true,
      status: true,
      rescheduledToId: true,
      closedAt: true,
      closeMode: true,
      closedBy: true,
      timezone: true,
      title: true,
      isManual: true,
      classGroupId: true,
      priceSnapshot: true,
      subject: CATALOG_NAME,
      grade: CATALOG_NAME,
      classGroup: { select: { subject: CATALOG_NAME, grade: CATALOG_NAME } },
      rescheduledFrom: { select: { date: true, startTime: true } },
    },
  });
}

export type WorkspaceSessionDetail = NonNullable<Awaited<ReturnType<typeof workspaceSessionDetail>>>;

/** One roster row: an enrolled student, or a roster row whose enrolment has since ended. */
export type WorkspaceSessionRosterRow = {
  studentProfileId: string;
  attendeeId: string | null;
  firstName: string;
  lastName: string;
  studentCode: string;
  /** Still ACTIVE in the class — only they can be checked in (D-W40 item 4). */
  enrolled: boolean;
  status: AttendanceStatus | null;
  /** T5 — an ABSENT row that reads "Not arrived" (every one on a live session). */
  notArrived: boolean;
  /** The active payment — or, once closed, a refunded one, as history. */
  payment: { id: string; amount: number; methodLabel: string; refunded: boolean } | null;
};

/**
 * The session's roster (D-W40 item 9): the class's ACTIVE enrolments, marked
 * or not, plus any roster row whose enrolment has since ended (its history
 * stays). Names are the workspace's own local record (rule 4). Ordered by name.
 */
export async function workspaceSessionRoster(
  db: Db,
  centerId: string,
  session: { id: string; classGroupId: string | null; closedAt: Date | null },
  readOnly: boolean,
): Promise<WorkspaceSessionRosterRow[]> {
  const profileSelect = { id: true, firstName: true, lastName: true, studentCode: true } as const;
  const [enrollments, attendees] = await Promise.all([
    session.classGroupId
      ? db.enrollment.findMany({
          where: scopedWhere(centerId, { classGroupId: session.classGroupId, status: ACTIVE, studentProfile: { active: true } }),
          select: { studentProfile: { select: profileSelect } },
        })
      : Promise.resolve([]),
    db.sessionAttendee.findMany({
      where: scopedWhere(centerId, { sessionId: session.id, studentProfileId: { not: null } }),
      select: {
        id: true,
        attendanceStatus: true,
        isDropIn: true,
        studentProfile: { select: profileSelect },
        payments: {
          where: { voided: false },
          orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
          select: { id: true, amount: true, methodLabelSnapshot: true, refunded: true },
        },
      },
    }),
  ]);
  const closed = session.closedAt !== null;
  const enrolledIds = new Set(enrollments.map((row) => row.studentProfile.id));
  const byStudent = new Map(attendees.map((row) => [row.studentProfile!.id, row]));
  const profiles = new Map<string, { id: string; firstName: string | null; lastName: string | null; studentCode: string }>();
  for (const row of enrollments) profiles.set(row.studentProfile.id, row.studentProfile);
  for (const row of attendees) if (row.studentProfile) profiles.set(row.studentProfile.id, row.studentProfile);

  const rows = [...profiles.values()].map((profile): WorkspaceSessionRosterRow => {
    const attendee = byStudent.get(profile.id);
    const payment =
      attendee?.payments.find((p) => !p.refunded) ?? (readOnly ? attendee?.payments.find((p) => p.refunded) : undefined) ?? null;
    return {
      studentProfileId: profile.id,
      attendeeId: attendee?.id ?? null,
      firstName: profile.firstName ?? "",
      lastName: profile.lastName ?? "",
      studentCode: profile.studentCode,
      enrolled: enrolledIds.has(profile.id),
      status: attendee?.attendanceStatus ?? null,
      notArrived: attendee ? attendanceDisplay(attendee, closed) === "NOT_ARRIVED" : false,
      payment: payment
        ? { id: payment.id, amount: payment.amount, methodLabel: payment.methodLabelSnapshot, refunded: payment.refunded }
        : null,
    };
  });
  return rows.sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
}
