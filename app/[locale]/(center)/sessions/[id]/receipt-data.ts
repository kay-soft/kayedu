import type { AttendanceStatus, SessionCloseMode } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import {
  sessionReceiptLines,
  sessionReceiptTotals,
  type SessionReceiptTotals,
} from "@/lib/db/payments";
import { listSessionAttendanceChanges, sessionClosure } from "@/lib/db/session-lifecycle";
import { fullName } from "@/lib/identity";

/** One "Changes during session" line, names already resolved for display. */
export type ReceiptChange = {
  id: string;
  studentName: string;
  fromStatus: AttendanceStatus;
  toStatus: AttendanceStatus;
  changedAt: Date;
  changedByName: string | null;
  reason: string | null;
  paymentVoided: boolean;
};

export type ReceiptClosure = {
  closedAt: Date;
  closeMode: SessionCloseMode;
  closedByName: string | null;
} | null;

/** A voided payment, as the receipt lists it (SEC-07, D-06 (a)). */
export type ReceiptVoid = {
  paymentId: string;
  studentName: string;
  amount: number;
  voidedAt: Date | null;
  voidedByName: string | null;
  reason: string | null;
};

/** A refunded payment, as the receipt lists it (SEC-19). */
export type ReceiptRefund = {
  paymentId: string;
  studentName: string;
  amount: number;
  refundedAt: Date;
  refundedByName: string | null;
  reason: string;
};

/** A PRESENT/LATE attendee with no payment (SEC-07). */
export type ReceiptUnpaid = {
  attendeeId: string;
  studentName: string;
  status: "PRESENT" | "LATE";
};

export type SessionReceiptView = {
  totals: SessionReceiptTotals;
  closure: ReceiptClosure;
  changes: ReceiptChange[];
  voids: ReceiptVoid[];
  refunds: ReceiptRefund[];
  unpaid: ReceiptUnpaid[];
};

/**
 * Everything a session receipt shows (R2, SEC-2b) — the frozen-snapshot
 * totals (`sessionReceiptTotals`: collected net of refunds, voided payments
 * outside every total), how and when the session closed, the live-session
 * change log, and — so nothing that took money off the books is invisible
 * (SEC-07) — every voided payment, every refund and every present-but-unpaid
 * attendee, by name. The on-screen receipt, the staff print route and the
 * teacher print route all load through here, so there is one receipt,
 * rendered three ways — never a second implementation of what it adds up.
 */
export async function loadSessionReceiptView(
  centerId: string,
  session: {
    id: string;
    closedAt: Date | null;
    closeMode: SessionCloseMode | null;
    closedBy: string | null;
  },
): Promise<SessionReceiptView> {
  const [totals, closure, changes, lines] = await Promise.all([
    sessionReceiptTotals(prisma, centerId, session.id),
    sessionClosure(prisma, centerId, session),
    listSessionAttendanceChanges(prisma, centerId, session.id),
    sessionReceiptLines(prisma, centerId, session.id),
  ]);

  return {
    totals,
    closure: closure
      ? {
          closedAt: closure.closedAt,
          closeMode: closure.closeMode,
          closedByName: closure.closedByName ? fullName(closure.closedByName) : null,
        }
      : null,
    changes: changes.map((change) => ({
      id: change.id,
      studentName: fullName(change.studentName),
      fromStatus: change.fromStatus,
      toStatus: change.toStatus,
      changedAt: change.changedAt,
      changedByName: change.changedByName ? fullName(change.changedByName) : null,
      reason: change.reason,
      paymentVoided: change.voidedPaymentId !== null,
    })),
    voids: lines.voids.map((line) => ({
      paymentId: line.paymentId,
      studentName: fullName(line.studentName),
      amount: line.amount,
      voidedAt: line.voidedAt,
      voidedByName: line.voidedByName ? fullName(line.voidedByName) : null,
      reason: line.reason,
    })),
    refunds: lines.refunds.map((line) => ({
      paymentId: line.paymentId,
      studentName: fullName(line.studentName),
      amount: line.amount,
      refundedAt: line.refundedAt,
      refundedByName: line.refundedByName ? fullName(line.refundedByName) : null,
      reason: line.reason,
    })),
    unpaid: lines.unpaid.map((line) => ({
      attendeeId: line.attendeeId,
      studentName: fullName(line.studentName),
      status: line.status,
    })),
  };
}
