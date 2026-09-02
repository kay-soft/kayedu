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
 * Revenue totals for one date range (and, optionally, one teacher), read
 * straight off the frozen `Payment` snapshots via a single SQL aggregate —
 * never fetched row-by-row and summed in memory (docs/02 §14). A voided
 * payment never contributes.
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
  return {
    collected: agg._sum.amount ?? 0,
    centerShare: agg._sum.centerShareSnapshot ?? 0,
    teacherShare: agg._sum.teacherShareSnapshot ?? 0,
    paymentCount: agg._count,
  };
}

export type TeacherRevenueRow = RevenueTotals & { teacherId: string };

/**
 * The by-teacher breakdown (spec §4.1 item 5): one `groupBy` on `Payment`,
 * keyed on the `teacherId` snapshot (docs/01 §3 note on `Payment.teacherId`)
 * rather than fetching every payment and reducing in JS.
 */
export async function revenueByTeacher(
  db: Db,
  centerId: string,
  range: DateRange,
): Promise<TeacherRevenueRow[]> {
  const sessionDate = dateWhere(range);
  const rows = await db.payment.groupBy({
    by: ["teacherId"],
    where: {
      centerId,
      voided: false,
      ...(sessionDate ? { session: { date: sessionDate } } : {}),
    },
    _sum: { amount: true, centerShareSnapshot: true, teacherShareSnapshot: true },
    _count: true,
  });

  return rows
    .map((row) => ({
      teacherId: row.teacherId,
      collected: row._sum.amount ?? 0,
      centerShare: row._sum.centerShareSnapshot ?? 0,
      teacherShare: row._sum.teacherShareSnapshot ?? 0,
      paymentCount: row._count,
    }))
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
  EXCUSED: 0,
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
