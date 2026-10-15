import type { Payment, Prisma, PrismaClient } from "@prisma/client";
// Relative imports on purpose — `npm run check:payments` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/sessions.ts and lib/validation/classes.ts).
import { splitShare } from "../money.ts";
import { writeAuditRow } from "./audit-row.ts";
import { moneyNumber } from "./money-sums.ts";
import { findActivePaymentMethod } from "./payment-methods.ts";
import {
  ensureSessionOpenOrAutoClose,
  loadGateSessionForAttendee,
  lockAttendeeRow,
  type SessionWriteOptions,
} from "./session-lifecycle.ts";
import {
  adjustUnpaidSettlementsForReversal,
  type AdjustedSettlement,
} from "./settlements.ts";

/**
 * The financial ledger's write path (M5, docs/01-data-model.md §3 — read that
 * section twice before touching this file). This is the ONLY place a
 * `Payment` row is created or voided; every action that touches money
 * (`app/[locale]/(center)/sessions/actions.ts`, `.../reception/actions.ts`)
 * calls in here rather than writing `prisma.payment.*` itself, so there is
 * exactly one place the snapshot math and the "one active payment per
 * attendee" rule can be gotten right or wrong.
 *
 * Both functions take a `Prisma.TransactionClient` — the caller wraps the
 * call in `prisma.$transaction()` (CLAUDE.md rule 2: "Payment" writes run
 * inside a transaction), with `WRITE_TRANSACTION_OPTIONS`, and writes its
 * audit row on the same client (SEC-60). `centerId` is taken explicitly rather
 * than through `ScopedDb`, exactly like `lib/db/students.ts`'s
 * `claimStudentCode`, because a transaction client isn't the app's scoped
 * singleton. No storage or e-mail call ever runs inside these transactions.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type RecordPaymentResult =
  | { ok: true; payment: Payment }
  | {
      ok: false;
      error:
        | "notFound"
        | "attendanceNotPayable"
        | "alreadyPaid"
        | "sessionCancelled"
        | "sessionRescheduled"
        | "sessionClosed"
        | "invalidMethod"
        | "missingCut";
    };

/**
 * Records one session payment, freezing `priceSnapshot`,
 * `centerShareSnapshot` and `teacherShareSnapshot` at this exact instant
 * (docs/01 §3, CLAUDE.md rule 2) — never recomputed later even if the
 * class's price or center-cut changes afterwards.
 *
 * - `amount`/`priceSnapshot` come from `Session.priceSnapshot`, read under
 *   the session and roster locks. A session's price is set from its class
 *   when it is created and — SYS price decision (docs/00 §5.1) — follows a
 *   class price edit only while the session is open and holds no payment
 *   (`repriceClassSessions`); once a payment exists the session keeps its
 *   price, and this payment's own snapshot never changes.
 * - `centerShareSnapshot`/`teacherShareSnapshot` come from the session's own
 *   `centerShareType`/`centerShareValue` override when one is set (M13, spec
 *   §5.1 "Center cut" — "overridable per class and per session"), else from
 *   the class's *current* `centerShareType`/`centerShareValue` — read fresh,
 *   right now — because that split is being decided the moment this payment
 *   is recorded. A later change to the class's cut (or a session's override)
 *   affects only payments recorded after that change (spec §7 acceptance
 *   criterion 3).
 * - "No debt" (spec §5): only PRESENT/LATE attendees are payable. An
 *   ABSENT attendee is simply not counted — there is nothing to freeze a
 *   payment against.
 * - The method (R1) is resolved **inside this transaction**, filtered by
 *   `centerId` AND `active` — another centre's method id, or an inactive
 *   one, is refused as `invalidMethod` whatever the caller sent. Its name is
 *   frozen onto `methodLabelSnapshot` right here, so a later rename never
 *   relabels this payment.
 * - A closed session (R2) accepts no payment; a session whose day ended is
 *   auto-closed by this call first (lib/db/session-lifecycle.ts) and the
 *   payment is refused as `sessionClosed` — returned, not thrown, so the
 *   caller's transaction still commits the close.
 * - A **one-time session** (R5, no class) has no class cut to fall back to:
 *   its own `centerShareType` + `centerShareValue` are the cut, frozen here
 *   exactly like an override would be. If either is missing the payment is
 *   refused (`missingCut`) — money is never guessed at (CLAUDE.md rule 2).
 *   The split itself is still `lib/money.ts`'s, the only place it lives.
 * - **At most one active (non-voided) payment per attendee (SEC-05).** The
 *   roster row is locked and the fact re-read by a fresh statement
 *   (`lockAttendeeRow`); the database backs it with the partial unique index
 *   `Payment_one_active_per_attendee`, and the insert targets that index with
 *   `ON CONFLICT … DO NOTHING`, so even a path that skipped the lock gets
 *   `alreadyPaid`, never a second row and never a thrown error.
 */
export async function recordPayment(
  tx: Db,
  centerId: string,
  attendeeId: string,
  paymentMethodId: string,
  recordedBy: string,
  options: SessionWriteOptions = {},
): Promise<RecordPaymentResult> {
  // One unlocked read carries everything this payment needs from the
  // session — the closure guard's own fields (passed to it as `peeked`, so it
  // costs no extra round trip) and the price/cut the payment freezes. The
  // money fields are read "right now", which is the instant the split is
  // decided (CLAUDE.md rule 2).
  const session = await loadGateSessionForAttendee(tx, centerId, attendeeId);
  if (!session) return { ok: false, error: "notFound" };

  // A cancelled session, one already superseded by a reschedule (M15, spec
  // §7 criterion 17 / §5.1 "Reschedule with linkage"), or a closed one (R2)
  // accepts no new payment — the one guard every write path shares
  // (lib/db/session-lifecycle.ts), which also row-locks the session so a
  // concurrent "End session" and this payment serialize.
  const gate = await ensureSessionOpenOrAutoClose(tx, session.id, centerId, options.now, {
    historicalBackfill: options.historicalBackfill,
    peeked: session,
  });
  if (gate.status === "missing") return { ok: false, error: "notFound" };
  if (gate.status === "refused") return { ok: false, error: gate.reason };

  // Lock this roster row (after the session's shared lock — the order every
  // attendee/payment write uses) and read, under that lock, the two facts a
  // concurrent write could change: the attendance status and whether an
  // active payment already exists. A correction to Absent or a second
  // payment for the same student serializes here.
  const roster = await lockAttendeeRow(tx, attendeeId, centerId);
  if (!roster || !roster.studentProfileId) return { ok: false, error: "notFound" };
  if (roster.attendanceStatus !== "PRESENT" && roster.attendanceStatus !== "LATE") {
    return { ok: false, error: "attendanceNotPayable" };
  }
  if (roster.hasActivePayment) return { ok: false, error: "alreadyPaid" };

  const method = await findActivePaymentMethod(tx, centerId, paymentMethodId);
  if (!method) return { ok: false, error: "invalidMethod" };

  // The session's price as read under the locks (`lockAttendeeRow`), not the
  // unlocked peek above: a class price edit may have repriced this open
  // session in between (SYS price decision, docs/00 §5.1).
  const amount = roster.sessionPrice;
  // A session's own override (M13) wins when set; otherwise the class's
  // current cut. Both are read fresh, right now — this is the instant the
  // split is decided and frozen (CLAUDE.md rule 2). A one-time session (R5)
  // has no class: its own two fields ARE the cut, and both must be present.
  const cut =
    session.classGroupId === null
      ? { type: session.centerShareType, value: session.centerShareValue }
      : {
          type: session.centerShareType ?? session.classCenterShareType,
          value: session.centerShareValue ?? session.classCenterShareValue,
        };
  if (cut.type === null || cut.value === null) return { ok: false, error: "missingCut" };
  const split = splitShare(amount, cut.type, cut.value);

  // Denormalized `teacherId` (not a money field) feeds the M6 by-teacher
  // analytics groupBy (docs/02 §14).
  const inserted = await tx.$queryRaw<Payment[]>`
    INSERT INTO "Payment"
      ("id", "centerId", "sessionId", "teacherId", "sessionAttendeeId", "studentProfileId",
       "amount", "paymentMethodId", "methodLabelSnapshot", "priceSnapshot",
       "centerShareSnapshot", "teacherShareSnapshot", "recordedBy", "recordedAt", "createdAt", "updatedAt")
    VALUES
      (gen_random_uuid()::text, ${centerId}, ${session.id}, ${session.teacherId}, ${attendeeId},
       ${roster.studentProfileId}, ${amount}, ${method.id}, ${method.name}, ${amount},
       ${split.centerShare}, ${split.teacherShare}, ${recordedBy}, now(), now(), now())
    ON CONFLICT ("sessionAttendeeId") WHERE "voided" = false DO NOTHING
    RETURNING *`;
  const payment = inserted[0];
  if (!payment) return { ok: false, error: "alreadyPaid" };
  return { ok: true, payment };
}

export type VoidPaymentResult =
  | {
      ok: true;
      payment: Payment;
      /**
       * DRAFT/APPROVED settlements whose stored total had counted this
       * payment and were live-adjusted down in this same transaction — the
       * caller audits each as `settlement.adjust`. In practice only a
       * pre-SEC-2b settlement can ever appear here: a settlement claims only
       * closed sessions' payments, and a closed session refuses every void.
       */
      adjustedSettlements: AdjustedSettlement[];
    }
  | {
      ok: false;
      error:
        | "notFound"
        | "alreadyVoided"
        | "alreadyRefunded"
        | "reasonRequired"
        | "sessionClosed"
        | "sessionCancelled"
        | "sessionRescheduled";
    };

/**
 * Voids a payment — never an `UPDATE` of its money fields (CLAUDE.md rule 2).
 * The row stays exactly as recorded; only `voided`/`voidReason`/`voidedAt`/
 * `voidedBy` change. The caller writes the `AuditLog` row in the same
 * transaction (docs/01 §3, CLAUDE.md rule 7, SEC-60) and may then call
 * `recordPayment` again for the same attendee — now allowed, since no active
 * payment remains.
 *
 * - The reason is **required** (it lives on the payment row; the audit row
 *   carries ids and amounts only — D-20).
 * - R2: refused on a closed session (a closed session is an immutable record).
 * - SEC-2b (D-07): refused on a CANCELLED or rescheduled session too — those
 *   cannot be cancelled or rescheduled while they hold active money, so there
 *   is nothing there to undo, and they close at the end of their day.
 * - A refunded payment cannot also be voided: the money already went back, and
 *   voiding it too would subtract it from revenue a second time (void ≠
 *   refund, never both on one row — also a CHECK in the database).
 */
export async function voidPayment(
  tx: Db,
  centerId: string,
  paymentId: string,
  reason: string,
  voidedBy: string,
  options: SessionWriteOptions = {},
): Promise<VoidPaymentResult> {
  if (reason.trim().length === 0) return { ok: false, error: "reasonRequired" };
  const located = await tx.payment.findFirst({
    where: { centerId, id: paymentId },
    select: { sessionId: true },
  });
  if (!located) return { ok: false, error: "notFound" };

  const gate = await ensureSessionOpenOrAutoClose(tx, located.sessionId, centerId, options.now, {
    historicalBackfill: options.historicalBackfill,
  });
  if (gate.status === "missing") return { ok: false, error: "notFound" };
  if (gate.status === "refused") return { ok: false, error: gate.reason };

  return voidPaymentRow(tx, centerId, paymentId, reason.trim(), voidedBy);
}

/**
 * `SELECT … FOR UPDATE` on one payment, scoped to `centerId`, then a fresh
 * read of it (SEC-12): a void and a refund — or two voids — on the same
 * payment serialize here, and whichever runs second sees the first's result.
 * Shared with lib/db/refunds.ts.
 */
export async function lockPaymentRow(
  tx: Db,
  centerId: string,
  paymentId: string,
): Promise<(Payment & { session: { date: Date; closedAt: Date | null } }) | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} AND "centerId" = ${centerId} FOR UPDATE`;
  if (!locked[0]) return null;
  return tx.payment.findFirst({
    where: { centerId, id: paymentId },
    include: { session: { select: { date: true, closedAt: true } } },
  });
}

/**
 * The void itself, for a caller that already holds the session open under
 * its lock — `voidPayment` above, and the void-on-absent inside
 * `lib/db/attendance.ts`'s `changeAttendanceStatus` (one void
 * implementation, two entry points). Also live-adjusts any unpaid
 * settlement whose total had counted this payment (R2 item 10, the same
 * rule a refund already followed since M14).
 */
export async function voidPaymentRow(
  tx: Db,
  centerId: string,
  paymentId: string,
  reason: string,
  voidedBy: string,
): Promise<VoidPaymentResult> {
  if (reason.trim().length === 0) return { ok: false, error: "reasonRequired" };
  const payment = await lockPaymentRow(tx, centerId, paymentId);
  if (!payment) return { ok: false, error: "notFound" };
  if (payment.voided) return { ok: false, error: "alreadyVoided" };
  if (payment.refunded) return { ok: false, error: "alreadyRefunded" };

  // Conditional on the state just read under the lock — never a blind write.
  const changed = await tx.payment.updateMany({
    where: { id: paymentId, centerId, voided: false, refunded: false },
    data: {
      voided: true,
      voidReason: reason.trim(),
      voidedAt: new Date(),
      voidedBy,
    },
  });
  if (changed.count !== 1) return { ok: false, error: "alreadyVoided" };
  const updated = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

  const adjustedSettlements = await adjustUnpaidSettlementsForReversal(
    tx,
    centerId,
    payment,
    payment.teacherShareSnapshot,
  );

  return { ok: true, payment: updated, adjustedSettlements };
}

/**
 * The `payment.record` audit row — ids, amounts and the frozen split only
 * (D-20: the method's label lives on the payment). Written on the payment's
 * own transaction (SEC-60) by every path that records one (the roster, the
 * reception desk).
 */
export async function writePaymentRecordAudit(
  tx: Db,
  centerId: string,
  actorUserId: string,
  payment: Payment,
): Promise<void> {
  await writeAuditRow(tx, {
    centerId,
    actorUserId,
    action: "payment.record",
    entityType: "Payment",
    entityId: payment.id,
    after: {
      amount: payment.amount,
      sessionId: payment.sessionId,
      paymentMethodId: payment.paymentMethodId,
      centerShareSnapshot: payment.centerShareSnapshot,
      teacherShareSnapshot: payment.teacherShareSnapshot,
    },
  });
}

// ── The session receipt ────────────────────────────────────────────────────

export type SessionReceiptTotals = {
  /** Collected **net of refunds** (SEC-19): paid − refunded. */
  collected: number;
  centerShare: number;
  teacherShare: number;
  /** Non-voided payments (a refunded one included — it was paid, then given back). */
  paidCount: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
  /** Refunds on this session's payments (SEC-19). */
  refundedCount: number;
  refundedAmount: number;
  /** Voided payments (SEC-07, D-06 (a)) — never counted, always shown. */
  voidedCount: number;
  voidedAmount: number;
  /** PRESENT/LATE attendees holding no non-voided payment (SEC-07). */
  unpaidCount: number;
  /** A session priced at 0 (D-26 (b)) — flagged on the receipt. */
  zeroPriced: boolean;
};

const EMPTY_STATUS_COUNTS = {
  PRESENT: 0,
  LATE: 0,
  ABSENT: 0,
} as const;

/**
 * The money + attendance summary a session receipt shows (spec §4.1 item 7,
 * docs/04 §5 "Receipt / money summary"): what was collected, net of refunds,
 * the centre/teacher split (both net of the refunds' reversals), the
 * present/late/absent counts, and — so nothing that moved money off the books
 * is invisible (SEC-07) — the voided payments and the present-but-unpaid
 * attendees. Every sum is a 64-bit SQL sum (D-17, lib/db/money-sums.ts).
 */
export async function sessionReceiptTotals(
  db: Db,
  centerId: string,
  sessionId: string,
): Promise<SessionReceiptTotals> {
  const [paymentRows, refundRows, unpaidRows, statusGroups, session] = await Promise.all([
    db.$queryRaw<
      {
        paid: bigint;
        paidCenter: bigint;
        paidTeacher: bigint;
        paidCount: number;
        voidedCount: number;
        voidedAmount: bigint;
      }[]
    >`
      SELECT
        COALESCE(SUM(p."amount") FILTER (WHERE NOT p."voided"), 0)::bigint AS "paid",
        COALESCE(SUM(p."centerShareSnapshot") FILTER (WHERE NOT p."voided"), 0)::bigint AS "paidCenter",
        COALESCE(SUM(p."teacherShareSnapshot") FILTER (WHERE NOT p."voided"), 0)::bigint AS "paidTeacher",
        (COUNT(*) FILTER (WHERE NOT p."voided"))::int AS "paidCount",
        (COUNT(*) FILTER (WHERE p."voided"))::int AS "voidedCount",
        COALESCE(SUM(p."amount") FILTER (WHERE p."voided"), 0)::bigint AS "voidedAmount"
      FROM "Payment" p
      WHERE p."centerId" = ${centerId} AND p."sessionId" = ${sessionId}`,
    db.$queryRaw<{ count: number; amount: bigint; center: bigint; teacher: bigint }[]>`
      SELECT
        COUNT(*)::int AS "count",
        COALESCE(SUM(r."amount"), 0)::bigint AS "amount",
        COALESCE(SUM(r."centerShareReversed"), 0)::bigint AS "center",
        COALESCE(SUM(r."teacherShareReversed"), 0)::bigint AS "teacher"
      FROM "Refund" r
      JOIN "Payment" p ON p."id" = r."paymentId"
      WHERE r."centerId" = ${centerId} AND p."centerId" = ${centerId} AND p."sessionId" = ${sessionId}`,
    db.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count"
      FROM "SessionAttendee" a
      WHERE a."centerId" = ${centerId} AND a."sessionId" = ${sessionId}
        AND a."attendanceStatus" IN ('PRESENT', 'LATE')
        AND NOT EXISTS (
          SELECT 1 FROM "Payment" p WHERE p."sessionAttendeeId" = a."id" AND NOT p."voided"
        )`,
    db.sessionAttendee.groupBy({
      by: ["attendanceStatus"],
      where: { centerId, sessionId },
      _count: { attendanceStatus: true },
    }),
    db.session.findFirst({ where: { centerId, id: sessionId }, select: { priceSnapshot: true } }),
  ]);

  const counts: Record<keyof typeof EMPTY_STATUS_COUNTS, number> = {
    ...EMPTY_STATUS_COUNTS,
  };
  for (const group of statusGroups) {
    counts[group.attendanceStatus] = group._count.attendanceStatus;
  }
  const paid = paymentRows[0];
  const refunds = refundRows[0];

  return {
    collected: moneyNumber(paid.paid) - moneyNumber(refunds.amount),
    centerShare: moneyNumber(paid.paidCenter) - moneyNumber(refunds.center),
    teacherShare: moneyNumber(paid.paidTeacher) - moneyNumber(refunds.teacher),
    paidCount: paid.paidCount,
    presentCount: counts.PRESENT,
    lateCount: counts.LATE,
    absentCount: counts.ABSENT,
    refundedCount: refunds.count,
    refundedAmount: moneyNumber(refunds.amount),
    voidedCount: paid.voidedCount,
    voidedAmount: moneyNumber(paid.voidedAmount),
    unpaidCount: unpaidRows[0]?.count ?? 0,
    zeroPriced: session?.priceSnapshot === 0,
  };
}

type PersonName = { firstName: string; lastName: string };

export type ReceiptVoidLine = {
  paymentId: string;
  studentName: PersonName;
  amount: number;
  voidedAt: Date | null;
  voidedByName: PersonName | null;
  reason: string | null;
};

export type ReceiptRefundLine = {
  paymentId: string;
  studentName: PersonName;
  amount: number;
  refundedAt: Date;
  refundedByName: PersonName | null;
  reason: string;
};

export type ReceiptUnpaidLine = {
  attendeeId: string;
  studentName: PersonName;
  status: "PRESENT" | "LATE";
};

export type SessionReceiptLines = {
  voids: ReceiptVoidLine[];
  refunds: ReceiptRefundLine[];
  unpaid: ReceiptUnpaidLine[];
};

/**
 * The receipt's named lines (SEC-07, D-06 (a), SEC-19): every voided payment
 * (who, how much, by whom, when, why), every refund, and every PRESENT/LATE
 * attendee with no payment. Names resolve as everywhere (CLAUDE.md rule 4):
 * the student's centre-local name over their global default, the actor's
 * centre-local `Membership` name over theirs.
 */
export async function sessionReceiptLines(
  db: Db,
  centerId: string,
  sessionId: string,
): Promise<SessionReceiptLines> {
  const studentSelect = {
    firstName: true,
    lastName: true,
    user: { select: { firstName: true, lastName: true } },
  } as const;
  const [voided, refunds, unpaid] = await Promise.all([
    db.payment.findMany({
      where: { centerId, sessionId, voided: true },
      orderBy: { voidedAt: "asc" },
      select: {
        id: true,
        amount: true,
        voidedAt: true,
        voidedBy: true,
        voidReason: true,
        studentProfile: { select: studentSelect },
      },
    }),
    db.refund.findMany({
      where: { centerId, payment: { centerId, sessionId } },
      orderBy: { refundedAt: "asc" },
      select: {
        paymentId: true,
        amount: true,
        refundedAt: true,
        refundedBy: true,
        reason: true,
        payment: { select: { studentProfile: { select: studentSelect } } },
      },
    }),
    db.sessionAttendee.findMany({
      where: {
        centerId,
        sessionId,
        attendanceStatus: { in: ["PRESENT", "LATE"] },
        payments: { none: { voided: false } },
        studentProfileId: { not: null },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, attendanceStatus: true, studentProfile: { select: studentSelect } },
    }),
  ]);

  const actorIds = [
    ...new Set([
      ...voided.map((row) => row.voidedBy).filter((id): id is string => Boolean(id)),
      ...refunds.map((row) => row.refundedBy),
    ]),
  ];
  const names = await actorNames(db, centerId, actorIds);
  const student = (profile: { firstName: string | null; lastName: string | null; user: PersonName } | null): PersonName => ({
    firstName: profile?.firstName ?? profile?.user.firstName ?? "",
    lastName: profile?.lastName ?? profile?.user.lastName ?? "",
  });

  return {
    voids: voided.map((row) => ({
      paymentId: row.id,
      studentName: student(row.studentProfile),
      amount: row.amount,
      voidedAt: row.voidedAt,
      voidedByName: row.voidedBy ? names.get(row.voidedBy) ?? null : null,
      reason: row.voidReason,
    })),
    refunds: refunds.map((row) => ({
      paymentId: row.paymentId,
      studentName: student(row.payment.studentProfile),
      amount: row.amount,
      refundedAt: row.refundedAt,
      refundedByName: names.get(row.refundedBy) ?? null,
      reason: row.reason,
    })),
    unpaid: unpaid.map((row) => ({
      attendeeId: row.id,
      studentName: student(row.studentProfile),
      status: row.attendanceStatus === "LATE" ? "LATE" : "PRESENT",
    })),
  };
}

/** Staff names at this centre: the local `Membership` name over the global one. */
export async function actorNames(
  db: Db,
  centerId: string,
  userIds: string[],
): Promise<Map<string, PersonName>> {
  if (userIds.length === 0) return new Map();
  const [users, memberships] = await Promise.all([
    db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, firstName: true, lastName: true },
    }),
    db.membership.findMany({
      where: { centerId, userId: { in: userIds } },
      select: { userId: true, firstName: true, lastName: true },
    }),
  ]);
  const local = new Map(memberships.map((m) => [m.userId, m]));
  return new Map(
    users.map((user) => {
      const membership = local.get(user.id);
      return [
        user.id,
        {
          firstName: membership?.firstName ?? user.firstName,
          lastName: membership?.lastName ?? user.lastName,
        },
      ];
    }),
  );
}

