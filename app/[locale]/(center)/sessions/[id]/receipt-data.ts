import type { AttendanceStatus, SessionCloseMode } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { sessionReceiptTotals, type SessionReceiptTotals } from "@/lib/db/payments";
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

export type SessionReceiptView = {
  totals: SessionReceiptTotals;
  closure: ReceiptClosure;
  changes: ReceiptChange[];
};

/**
 * Everything a session receipt shows (R2) — the frozen-snapshot totals
 * (`sessionReceiptTotals`, voided payments excluded as always), how and when
 * the session closed, and the live-session change log. The on-screen
 * receipt, the staff print route and the teacher print route all load
 * through here, so there is one receipt, rendered three ways — never a
 * second implementation of what it adds up.
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
  const [totals, closure, changes] = await Promise.all([
    sessionReceiptTotals(prisma, centerId, session.id),
    sessionClosure(prisma, centerId, session),
    listSessionAttendanceChanges(prisma, centerId, session.id),
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
  };
}
