import type {
  AttendanceStatus,
  Prisma,
  PrismaClient,
  SessionAttendanceChange,
  SessionAttendee,
} from "@prisma/client";
// Relative imports on purpose — gates and the seed import this module
// directly, outside the Next.js runtime (docs/02 §5).
import { writeAuditRow } from "./audit-row.ts";

/**
 * **The one writer of a live attendance status change** (R2, T5). Every path
 * that moves an already-marked roster row goes through `applyAttendanceChange`:
 * the roster's correction (`changeAttendanceStatus`, lib/db/attendance.ts),
 * the reset a void or refund writes on a live session
 * (`resetAttendanceAfterReversal`, called by lib/db/payments.ts and
 * lib/db/refunds.ts), and a re-check-in of a reset student
 * (`recheckInAttendee`). Its own module so the payment modules and the
 * attendance module can share it without importing each other.
 *
 * The caller already holds, in its own transaction, the session's shared lock
 * and this attendee's row lock (`lockAttendeeRow`) — the order every
 * attendee/payment write takes — and passes the row as re-read under them.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Why a change happened, on its `attendance.correct` audit row (ids only, D-20). */
export type AttendanceChangeTrigger = "payment.void" | "payment.refund" | "attendance.recheckIn";

export async function applyAttendanceChange(
  tx: Db,
  params: {
    centerId: string;
    /** Re-read under the row lock; `studentProfileId` must be set. */
    attendee: SessionAttendee & { studentProfileId: string };
    toStatus: AttendanceStatus;
    changedBy: string;
    reason: string | null;
    voidedPaymentId?: string | null;
    refundedPaymentId?: string | null;
    trigger?: AttendanceChangeTrigger;
    now: Date;
  },
): Promise<{ attendee: SessionAttendee; change: SessionAttendanceChange }> {
  const { attendee } = params;
  const fromStatus = attendee.attendanceStatus;
  const updated = await tx.sessionAttendee.update({
    where: { id: attendee.id },
    data: { attendanceStatus: params.toStatus, recordedBy: params.changedBy, recordedAt: params.now },
  });
  const change = await tx.sessionAttendanceChange.create({
    data: {
      centerId: params.centerId,
      sessionId: attendee.sessionId,
      studentProfileId: attendee.studentProfileId,
      fromStatus,
      toStatus: params.toStatus,
      voidedPaymentId: params.voidedPaymentId ?? null,
      refundedPaymentId: params.refundedPaymentId ?? null,
      reason: params.reason,
      changedBy: params.changedBy,
      changedAt: params.now,
    },
  });
  // The audit row commits with the change (CLAUDE.md rule 7, SEC-60). Ids
  // only (D-20) — the reason lives on the change row and the payment.
  await writeAuditRow(tx, {
    centerId: params.centerId,
    actorUserId: params.changedBy,
    action: "attendance.correct",
    entityType: "SessionAttendee",
    entityId: attendee.id,
    before: { attendanceStatus: fromStatus },
    after: {
      attendanceStatus: params.toStatus,
      sessionId: attendee.sessionId,
      changeId: change.id,
      voidedPaymentId: change.voidedPaymentId,
      ...(change.refundedPaymentId ? { refundedPaymentId: change.refundedPaymentId } : {}),
      ...(params.trigger ? { trigger: params.trigger } : {}),
    },
  });
  return { attendee: updated, change };
}

/**
 * T5 — a void or refund on a **live** session puts the student back where
 * they were before check-in: PRESENT/LATE → ABSENT ("Not arrived"), in the
 * money write's own transaction, with one change row naming the voided or
 * refunded payment and the `attendance.correct` audit row. The row is never
 * deleted (payments cascade from it; the voided/refunded row must survive).
 * A row already ABSENT — or gone — is left alone (returns null).
 *
 * The caller holds the attendee's row lock; the status is re-read here by a
 * fresh statement, so a concurrent change that committed while it waited is
 * seen. Never called for a closed session (void and refund refuse one) nor
 * for a `historicalBackfill` script write, which states history explicitly.
 */
export async function resetAttendanceAfterReversal(
  tx: Db,
  params: {
    centerId: string;
    attendeeId: string;
    changedBy: string;
    reason: string;
    cause: { voidedPaymentId: string } | { refundedPaymentId: string };
    now: Date;
  },
): Promise<SessionAttendanceChange | null> {
  const attendee = await tx.sessionAttendee.findFirst({
    where: { centerId: params.centerId, id: params.attendeeId },
  });
  if (!attendee || !attendee.studentProfileId) return null;
  if (attendee.attendanceStatus !== "PRESENT" && attendee.attendanceStatus !== "LATE") return null;
  const voided = "voidedPaymentId" in params.cause;
  const { change } = await applyAttendanceChange(tx, {
    centerId: params.centerId,
    attendee: { ...attendee, studentProfileId: attendee.studentProfileId },
    toStatus: "ABSENT",
    changedBy: params.changedBy,
    reason: params.reason,
    voidedPaymentId: "voidedPaymentId" in params.cause ? params.cause.voidedPaymentId : null,
    refundedPaymentId: "refundedPaymentId" in params.cause ? params.cause.refundedPaymentId : null,
    trigger: voided ? "payment.void" : "payment.refund",
    now: params.now,
  });
  return change;
}
