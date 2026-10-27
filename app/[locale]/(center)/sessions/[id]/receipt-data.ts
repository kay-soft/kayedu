import type { AttendanceStatus, SessionCloseMode } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import {
  sessionReceiptLines,
  sessionReceiptTotals,
  type SessionReceiptTotals,
} from "@/lib/db/payments";
import { sessionChangeLog, sessionClosure, type ChangeLogEvent } from "@/lib/db/session-lifecycle";
import { fullName } from "@/lib/identity";

/** One line of a student's "Changes during session" timeline (T5), names resolved for display. */
export type ReceiptChangeEvent =
  | { kind: "checkIn"; at: Date; status: AttendanceStatus }
  | { kind: "payment"; at: Date; amount: number; byName: string | null }
  | { kind: "reversal"; at: Date; reversal: "void" | "refund"; amount: number; reason: string | null; byName: string | null }
  | { kind: "change"; at: Date; fromStatus: AttendanceStatus; toStatus: AttendanceStatus; reason: string | null; byName: string | null };

/** One changed student and their timeline, in order. */
export type ReceiptChange = {
  studentProfileId: string;
  studentName: string;
  events: ReceiptChangeEvent[];
};

function receiptEvent(event: ChangeLogEvent): ReceiptChangeEvent {
  const name = (person: { firstName: string; lastName: string } | null) => (person ? fullName(person) : null);
  switch (event.kind) {
    case "checkIn":
      return event;
    case "payment":
      return { kind: "payment", at: event.at, amount: event.amount, byName: name(event.byName) };
    case "reversal":
      return {
        kind: "reversal",
        at: event.at,
        reversal: event.reversal,
        amount: event.amount,
        reason: event.reason,
        byName: name(event.byName),
      };
    case "change":
      return {
        kind: "change",
        at: event.at,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reason: event.reason,
        byName: name(event.byName),
      };
  }
}

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
 * change log (T5: one timeline per changed student — `sessionChangeLog`), and — so nothing that took money off the books is invisible
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
    sessionChangeLog(prisma, centerId, session.id),
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
    changes: changes.map((entry) => ({
      studentProfileId: entry.studentProfileId,
      studentName: fullName(entry.studentName),
      events: entry.events.map(receiptEvent),
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
