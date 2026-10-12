import type { AttendanceStatus, Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:analytics` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/payments.ts and lib/db/attendance.ts). `/dashboard` and `/analytics`
// both call these functions with different date-range defaults, so the
// revenue/count math lives here exactly once (docs/02-architecture.md §14).

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * `from`/`to` are inclusive UTC-midnight bounds on `Session.date`. Either (or
 * both) may be `null` for an unbounded ("all-time") edge — the M6 Analytics
 * "all-time" filter never fabricates a fake epoch bound.
 */
export type DateRange = { from: Date | null; to: Date | null };

function dateWhere(range: DateRange): Prisma.DateTimeFilter | undefined {
  if (!range.from && !range.to) return undefined;
  return {
    ...(range.from ? { gte: range.from } : {}),
    ...(range.to ? { lte: range.to } : {}),
  };
}

// ── Revenue (frozen Payment snapshots only — never the live class config) ──

export type RevenueTotals = {
  collected: number;
  centerShare: number;
  teacherShare: number;
  paymentCount: number;
};

const EMPTY_REVENUE: RevenueTotals = {
  collected: 0,
  centerShare: 0,
  teacherShare: 0,
  paymentCount: 0,
};

/**
 * Refunds (M14, spec §5 "Void vs. refund") reversed within a date range (and,
 * optionally, for one teacher) — read off `Refund`'s own frozen reversal
 * amounts, never recomputed from the `Payment` it reverses. Every refunded
 * payment is itself non-voided (a voided payment can never be refunded,
 * `lib/db/refunds.ts`), so it is still counted in `revenueTotals`'s own
 * `voided: false` aggregate above; this is what gets subtracted back out.
 */
async function refundTotals(
  db: Db,
  centerId: string,
  range: DateRange,
  teacherId?: string | null,
): Promise<{ amount: number; centerShare: number; teacherShare: number }> {
  const sessionDate = dateWhere(range);
  const agg = await db.refund.aggregate({
    where: {
      centerId,
      ...(teacherId ? { teacherId } : {}),
      ...(sessionDate ? { payment: { session: { date: sessionDate } } } : {}),
    },
    _sum: { amount: true, centerShareReversed: true, teacherShareReversed: true },
  });
  return {
    amount: agg._sum.amount ?? 0,
    centerShare: agg._sum.centerShareReversed ?? 0,
    teacherShare: agg._sum.teacherShareReversed ?? 0,
  };
}

/**
 * Revenue totals for one date range (and, optionally, one teacher), read
 * straight off the frozen `Payment` snapshots via a single SQL aggregate —
 * never fetched row-by-row and summed in memory (docs/02 §14). A voided
 * payment never contributes. A refunded payment's amounts are subtracted
 * back out (M14, spec §5 "Void vs. refund" — "collected revenue is reduced,
 * and so are that payment's centre and teacher shares"): the payment itself
 * is not voided, so it still appears in the aggregate above, and `Refund`'s
 * own frozen reversal amounts are what get subtracted here.
 */
export async function revenueTotals(
  db: Db,
  centerId: string,
  range: DateRange,
  teacherId?: string | null,
): Promise<RevenueTotals> {
  const sessionDate = dateWhere(range);
  const agg = await db.payment.aggregate({
    where: {
      centerId,
      voided: false,
      ...(teacherId ? { teacherId } : {}),
      ...(sessionDate ? { session: { date: sessionDate } } : {}),
    },
    _sum: { amount: true, centerShareSnapshot: true, teacherShareSnapshot: true },
    _count: true,
  });

  if (agg._count === 0) return EMPTY_REVENUE;

  const refunds = await refundTotals(db, centerId, range, teacherId);
  return {
    collected: (agg._sum.amount ?? 0) - refunds.amount,
    centerShare: (agg._sum.centerShareSnapshot ?? 0) - refunds.centerShare,
    teacherShare: (agg._sum.teacherShareSnapshot ?? 0) - refunds.teacherShare,
    paymentCount: agg._count,
  };
}

export type TeacherRevenueRow = RevenueTotals & { teacherId: string };

/**
 * The by-teacher breakdown (spec §4.1 item 5): one `groupBy` on `Payment`,
 * keyed on the `teacherId` snapshot (docs/01 §3 note on `Payment.teacherId`)
 * rather than fetching every payment and reducing in JS. Refunds are
 * subtracted per teacher via a second `groupBy` on `Refund.teacherId` (M14)
 * — denormalized on `Refund` for exactly this reason (Prisma cannot
 * `groupBy` on a related model's column). Every refunded payment's teacher
 * already has a row in `rows` (a refund can only exist against a non-voided
 * payment, which is what `rows` sums), so there is never an orphan refund
 * row to add.
 */
export async function revenueByTeacher(
  db: Db,
  centerId: string,
  range: DateRange,
): Promise<TeacherRevenueRow[]> {
  const sessionDate = dateWhere(range);
  const [rows, refundRows] = await Promise.all([
    db.payment.groupBy({
      by: ["teacherId"],
      where: {
        centerId,
        voided: false,
        ...(sessionDate ? { session: { date: sessionDate } } : {}),
      },
      _sum: { amount: true, centerShareSnapshot: true, teacherShareSnapshot: true },
      _count: true,
    }),
    db.refund.groupBy({
      by: ["teacherId"],
      where: {
        centerId,
        ...(sessionDate ? { payment: { session: { date: sessionDate } } } : {}),
      },
      _sum: { amount: true, centerShareReversed: true, teacherShareReversed: true },
    }),
  ]);

  const refundByTeacher = new Map(refundRows.map((row) => [row.teacherId, row]));

  return rows
    .map((row) => {
      const refund = refundByTeacher.get(row.teacherId);
      return {
        teacherId: row.teacherId,
        collected: (row._sum.amount ?? 0) - (refund?._sum.amount ?? 0),
        centerShare: (row._sum.centerShareSnapshot ?? 0) - (refund?._sum.centerShareReversed ?? 0),
        teacherShare: (row._sum.teacherShareSnapshot ?? 0) - (refund?._sum.teacherShareReversed ?? 0),
        paymentCount: row._count,
      };
    })
    .sort((a, b) => b.collected - a.collected);
}

// ── Expenses ────────────────────────────────────────────────────────────────

export type ExpenseTotals = { total: number; count: number };

export async function expenseTotals(
  db: Db,
  centerId: string,
  range: DateRange,
): Promise<ExpenseTotals> {
  const date = dateWhere(range);
  const agg = await db.expense.aggregate({
    where: { centerId, ...(date ? { date } : {}) },
    _sum: { amount: true },
    _count: true,
  });
  return { total: agg._sum.amount ?? 0, count: agg._count };
}

// ── Users (spec §4.1 item 5 "Users: total/new students, total/active/new teachers") ─

export type StudentCounts = { total: number; new: number };
export type TeacherCounts = { total: number; active: number; new: number };

const TEACHER_ROLE = "TEACHER" as const;

export async function studentCounts(
  db: Db,
  centerId: string,
  range: DateRange,
): Promise<StudentCounts> {
  const createdAt = dateWhere(range);
  const [total, newCount] = await Promise.all([
    db.studentProfile.count({ where: { centerId, active: true } }),
    createdAt
      ? db.studentProfile.count({ where: { centerId, createdAt } })
      : Promise.resolve(0),
  ]);
  return { total, new: newCount };
}

export async function teacherCounts(
  db: Db,
  centerId: string,
  range: DateRange,
): Promise<TeacherCounts> {
  const createdAt = dateWhere(range);
  const [total, active, newCount] = await Promise.all([
    db.membership.count({ where: { centerId, role: TEACHER_ROLE } }),
    db.membership.count({ where: { centerId, role: TEACHER_ROLE, active: true } }),
    createdAt
      ? db.membership.count({ where: { centerId, role: TEACHER_ROLE, createdAt } })
      : Promise.resolve(0),
  ]);
  return { total, active, new: newCount };
}

// ── Attendance status counts (Dashboard "today" summary) ────────────────────

export type AttendanceStatusCounts = Record<AttendanceStatus, number>;

const EMPTY_STATUS_COUNTS: AttendanceStatusCounts = {
  PRESENT: 0,
  LATE: 0,
  ABSENT: 0,
};

/**
 * Attendance-status counts for every session in a date range — one `groupBy`
 * on `SessionAttendee`, the same pattern `sessionReceiptTotals`
 * (`lib/db/payments.ts`) already uses for a single session.
 */
export async function attendanceStatusCounts(
  db: Db,
  centerId: string,
  range: DateRange,
): Promise<AttendanceStatusCounts> {
  const date = dateWhere(range);
  const rows = await db.sessionAttendee.groupBy({
    by: ["attendanceStatus"],
    where: { centerId, ...(date ? { session: { date } } : {}) },
    _count: { attendanceStatus: true },
  });

  const counts = { ...EMPTY_STATUS_COUNTS };
  for (const row of rows) counts[row.attendanceStatus] = row._count.attendanceStatus;
  return counts;
}
