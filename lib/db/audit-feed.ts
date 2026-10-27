import type { AttendanceStatus, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:security` reads the feed
// directly, outside the Next.js runtime.
import { actorNames } from "./payments.ts";

/**
 * The centre audit screen's reads (SEC-2b, D-06 (a), SEC-07). Centre-scoped
 * (`centerId` on every query) and gated on `audit.view` by its page.
 *
 * - **The trail itself is carved out of the data-visibility window** (docs/00
 *   §5.1 "Data visibility window": an audit trail a centre cannot read past
 *   last month is not an audit trail). Each row is shown with its own context
 *   — the student, the amount, the reason — read from the record the row
 *   names, because since D-20 the audit row itself carries ids and amounts
 *   only: the reason lives on the payment, the refund, the change-log row or
 *   the expense.
 * - **Unpaid check-ins are attendance, not audit**, so that list is clamped to
 *   the window like every other attendance read.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const AUDIT_FILTERS = ["all", "voids", "absent", "refunds", "settlements", "pricing", "unpaid"] as const;
export type AuditFilter = (typeof AUDIT_FILTERS)[number];

/** Price and centre-cut configuration — every place money is configured. */
const PRICING_ACTIONS = [
  "classGroup.create",
  "classGroup.update",
  "session.create",
  "session.shareOverride.update",
  "center.settings.update",
  "catalog.selection.update",
];

const FILTER_WHERE: Record<Exclude<AuditFilter, "unpaid">, Prisma.AuditLogWhereInput> = {
  all: {},
  voids: { action: { in: ["payment.void", "expense.void"] } },
  absent: { action: "attendance.correct", after: { path: ["attendanceStatus"], equals: "ABSENT" } },
  refunds: { action: "payment.refund" },
  settlements: { action: { startsWith: "settlement." } },
  pricing: { action: { in: PRICING_ACTIONS } },
};

type Name = { firstName: string; lastName: string };

export type AuditEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: Date;
  actorName: Name | null;
  /** The person the row is about (the paying student; the paid teacher). */
  subjectName: Name | null;
  amount: number | null;
  /** The reason, from the record itself (D-20). */
  reason: string | null;
  sessionId: string | null;
  /** True when an OWNER approved/paid a settlement they created (D-12). */
  selfApproved: boolean;
  /** Numbers and statuses the row itself carries, for "before → after". */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

function asObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** One page of this centre's audit trail, newest first, with each row's context. */
export async function loadAuditFeed(
  db: Db,
  centerId: string,
  filter: Exclude<AuditFilter, "unpaid">,
  page: { take: number; skip: number },
): Promise<{ entries: AuditEntry[]; total: number }> {
  const where: Prisma.AuditLogWhereInput = { centerId, ...FILTER_WHERE[filter] };
  const [rows, total] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: page.take, skip: page.skip }),
    db.auditLog.count({ where }),
  ]);
  if (rows.length === 0) return { entries: [], total };

  const parsed = rows.map((row) => ({ row, before: asObject(row.before), after: asObject(row.after) }));
  const paymentIds = new Set<string>();
  const settlementIds = new Set<string>();
  const changeIds = new Set<string>();
  const expenseIds = new Set<string>();
  for (const { row, after } of parsed) {
    if (row.entityType === "Payment") paymentIds.add(row.entityId);
    if (row.entityType === "Settlement") settlementIds.add(row.entityId);
    if (row.entityType === "Expense") expenseIds.add(row.entityId);
    const changeId = str(after?.changeId);
    if (changeId) changeIds.add(changeId);
  }

  const studentSelect = {
    firstName: true,
    lastName: true,
    user: { select: { firstName: true, lastName: true } },
  } as const;
  const [payments, refunds, settlements, changes, expenses] = await Promise.all([
    paymentIds.size
      ? db.payment.findMany({
          where: { centerId, id: { in: [...paymentIds] } },
          select: { id: true, amount: true, sessionId: true, voidReason: true, studentProfile: { select: studentSelect } },
        })
      : [],
    paymentIds.size
      ? db.refund.findMany({ where: { centerId, paymentId: { in: [...paymentIds] } }, select: { paymentId: true, reason: true } })
      : [],
    settlementIds.size
      ? db.settlement.findMany({
          where: { centerId, id: { in: [...settlementIds] } },
          select: { id: true, teacherId: true, totalAmount: true, sessionId: true },
        })
      : [],
    changeIds.size
      ? db.sessionAttendanceChange.findMany({
          where: { centerId, id: { in: [...changeIds] } },
          select: { id: true, reason: true, sessionId: true, studentProfile: { select: studentSelect } },
        })
      : [],
    expenseIds.size
      ? db.expense.findMany({ where: { centerId, id: { in: [...expenseIds] } }, select: { id: true, amount: true, voidReason: true } })
      : [],
  ]);
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  const refundByPayment = new Map(refunds.map((r) => [r.paymentId, r]));
  const settlementById = new Map(settlements.map((s) => [s.id, s]));
  const changeById = new Map(changes.map((c) => [c.id, c]));
  const expenseById = new Map(expenses.map((e) => [e.id, e]));

  const people = await actorNames(db, centerId, [
    ...new Set([
      ...rows.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)),
      ...settlements.map((s) => s.teacherId),
    ]),
  ]);
  const student = (profile: { firstName: string | null; lastName: string | null; user: Name } | null | undefined): Name | null =>
    profile ? { firstName: profile.firstName ?? profile.user.firstName, lastName: profile.lastName ?? profile.user.lastName } : null;

  const entries = parsed.map(({ row, before, after }): AuditEntry => {
    const payment = row.entityType === "Payment" ? paymentById.get(row.entityId) : undefined;
    const settlement = row.entityType === "Settlement" ? settlementById.get(row.entityId) : undefined;
    const expense = row.entityType === "Expense" ? expenseById.get(row.entityId) : undefined;
    const change = changeById.get(str(after?.changeId) ?? "");
    let reason: string | null = null;
    if (row.action === "payment.void") reason = payment?.voidReason ?? change?.reason ?? null;
    else if (row.action === "payment.refund") reason = refundByPayment.get(row.entityId)?.reason ?? null;
    else if (row.action === "attendance.correct") reason = change?.reason ?? null;
    else if (row.action === "expense.void") reason = expense?.voidReason ?? null;
    const amountFrom = (value: unknown) => (typeof value === "number" ? value : null);
    return {
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      createdAt: row.createdAt,
      actorName: row.actorUserId ? people.get(row.actorUserId) ?? null : null,
      subjectName: settlement
        ? people.get(settlement.teacherId) ?? null
        : student(payment?.studentProfile ?? change?.studentProfile),
      amount:
        payment?.amount ??
        expense?.amount ??
        amountFrom(after?.totalAmount) ??
        settlement?.totalAmount ??
        amountFrom(before?.amount),
      reason,
      sessionId: payment?.sessionId ?? change?.sessionId ?? settlement?.sessionId ?? str(after?.sessionId),
      selfApproved: after?.selfApproved === true,
      before,
      after,
    };
  });
  return { entries, total };
}

export type UnpaidCheckIn = {
  attendeeId: string;
  sessionId: string;
  sessionDate: Date;
  studentName: Name;
  status: Extract<AttendanceStatus, "PRESENT" | "LATE">;
  recordedByName: Name | null;
  recordedAt: Date;
};

/**
 * PRESENT/LATE attendees with no payment standing (SEC-07: "a present-but-
 * unpaid student is flagged nowhere"), newest session first, never older
 * than `floor` (the visibility window — `null` only for a platform admin).
 */
export async function loadUnpaidCheckIns(
  db: Db,
  centerId: string,
  floor: Date | null,
  page: { take: number; skip: number },
): Promise<{ rows: UnpaidCheckIn[]; total: number }> {
  const where: Prisma.SessionAttendeeWhereInput = {
    centerId,
    attendanceStatus: { in: ["PRESENT", "LATE"] },
    studentProfileId: { not: null },
    // T5 — "standing" = neither voided nor refunded: a refund resets the
    // student on a live session, so one re-checked-in and not yet re-paid is unpaid.
    payments: { none: { voided: false, refunded: false } },
    ...(floor ? { session: { date: { gte: floor } } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.sessionAttendee.findMany({
      where,
      orderBy: [{ session: { date: "desc" } }, { recordedAt: "desc" }],
      take: page.take,
      skip: page.skip,
      select: {
        id: true,
        sessionId: true,
        attendanceStatus: true,
        recordedBy: true,
        recordedAt: true,
        session: { select: { date: true } },
        studentProfile: { select: { firstName: true, lastName: true, user: { select: { firstName: true, lastName: true } } } },
      },
    }),
    db.sessionAttendee.count({ where }),
  ]);
  const recorders = await actorNames(db, centerId, [...new Set(rows.map((row) => row.recordedBy))]);
  return {
    total,
    rows: rows.map((row) => ({
      attendeeId: row.id,
      sessionId: row.sessionId,
      sessionDate: row.session.date,
      studentName: {
        firstName: row.studentProfile?.firstName ?? row.studentProfile?.user.firstName ?? "",
        lastName: row.studentProfile?.lastName ?? row.studentProfile?.user.lastName ?? "",
      },
      status: row.attendanceStatus === "LATE" ? "LATE" : "PRESENT",
      recordedByName: recorders.get(row.recordedBy) ?? null,
      recordedAt: row.recordedAt,
    })),
  };
}
