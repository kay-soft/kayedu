import { Prisma } from "@prisma/client";
import type { AttendanceStatus, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:analytics` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/payments.ts and lib/db/attendance.ts). `/dashboard` and `/analytics`
// both call these functions with different date-range defaults, so the
// revenue/count math lives here exactly once (docs/02-architecture.md §14).
import { EXCLUDE_DROP_IN_NO_SHOWS } from "../attendance-rules.ts";
import { dateKey } from "../scheduling.ts";
import { moneyNumber } from "./money-sums.ts";

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
//
// Every money sum here is a 64-bit SQL sum (SEC-2b, D-17 (b), SEC-24):
// Prisma's own `_sum` over an `integer` column is itself an `integer` and
// overflowed for a large centre over a long range. Day bounds are compared as
// calendar days (`::date`) against `Session.date`, a UTC-midnight day marker.

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

/** `AND <column> …` for an inclusive day range — empty when unbounded. */
function dayRangeSql(column: Prisma.Sql, range: DateRange): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (range.from) parts.push(Prisma.sql`AND ${column} >= ${dateKey(range.from)}::date`);
  if (range.to) parts.push(Prisma.sql`AND ${column} <= ${dateKey(range.to)}::date`);
  return parts.length > 0 ? Prisma.join(parts, " ") : Prisma.empty;
}

const SESSION_DATE = Prisma.sql`s."date"`;

type MoneyRow = { amount: bigint; center: bigint; teacher: bigint; count: number };

/**
 * Refunds (M14, spec §5 "Void vs. refund") reversed within a date range (and,
 * optionally, for one teacher) — read off `Refund`'s own frozen reversal
 * amounts, never recomputed from the `Payment` it reverses. Every refunded
 * payment is itself non-voided (a voided payment can never be refunded,
 * `lib/db/refunds.ts`), so it is still counted in `revenueTotals`'s own
 * non-voided sum; this is what gets subtracted back out.
 */
async function refundTotals(
  db: Db,
  centerId: string,
  range: DateRange,
  teacherId?: string | null,
): Promise<{ amount: number; centerShare: number; teacherShare: number }> {
  const rows = await db.$queryRaw<MoneyRow[]>`
    SELECT COALESCE(SUM(r."amount"), 0)::bigint AS "amount",
           COALESCE(SUM(r."centerShareReversed"), 0)::bigint AS "center",
           COALESCE(SUM(r."teacherShareReversed"), 0)::bigint AS "teacher",
           COUNT(*)::int AS "count"
    FROM "Refund" r
    JOIN "Payment" p ON p."id" = r."paymentId"
    JOIN "Session" s ON s."id" = p."sessionId"
    WHERE r."centerId" = ${centerId}
      ${teacherId ? Prisma.sql`AND r."teacherId" = ${teacherId}` : Prisma.empty}
      ${dayRangeSql(SESSION_DATE, range)}`;
  return {
    amount: moneyNumber(rows[0]?.amount),
    centerShare: moneyNumber(rows[0]?.center),
    teacherShare: moneyNumber(rows[0]?.teacher),
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
  const rows = await db.$queryRaw<MoneyRow[]>`
    SELECT COALESCE(SUM(p."amount"), 0)::bigint AS "amount",
           COALESCE(SUM(p."centerShareSnapshot"), 0)::bigint AS "center",
           COALESCE(SUM(p."teacherShareSnapshot"), 0)::bigint AS "teacher",
           COUNT(*)::int AS "count"
    FROM "Payment" p
    JOIN "Session" s ON s."id" = p."sessionId"
    WHERE p."centerId" = ${centerId} AND p."voided" = false
      ${teacherId ? Prisma.sql`AND p."teacherId" = ${teacherId}` : Prisma.empty}
      ${dayRangeSql(SESSION_DATE, range)}`;
  const agg = rows[0];
  if (!agg || agg.count === 0) return EMPTY_REVENUE;

  const refunds = await refundTotals(db, centerId, range, teacherId);
  return {
    collected: moneyNumber(agg.amount) - refunds.amount,
    centerShare: moneyNumber(agg.center) - refunds.centerShare,
    teacherShare: moneyNumber(agg.teacher) - refunds.teacherShare,
    paymentCount: agg.count,
  };
}

export type TeacherRevenueRow = RevenueTotals & { teacherId: string };

/**
 * The by-teacher breakdown (spec §4.1 item 5): one grouped SQL sum on
 * `Payment`, keyed on the `teacherId` snapshot (docs/01 §3 note on
 * `Payment.teacherId`) rather than fetching every payment and reducing in JS.
 * Refunds are subtracted per teacher via a second grouped sum on
 * `Refund.teacherId` (M14) — denormalized on `Refund` for exactly this reason.
 * Every refunded payment's teacher already has a row in `rows` (a refund can
 * only exist against a non-voided payment, which is what `rows` sums), so
 * there is never an orphan refund row to add.
 */
export async function revenueByTeacher(
  db: Db,
  centerId: string,
  range: DateRange,
): Promise<TeacherRevenueRow[]> {
  const [rows, refundRows] = await Promise.all([
    db.$queryRaw<(MoneyRow & { teacherId: string })[]>`
      SELECT p."teacherId",
             COALESCE(SUM(p."amount"), 0)::bigint AS "amount",
             COALESCE(SUM(p."centerShareSnapshot"), 0)::bigint AS "center",
             COALESCE(SUM(p."teacherShareSnapshot"), 0)::bigint AS "teacher",
             COUNT(*)::int AS "count"
      FROM "Payment" p
      JOIN "Session" s ON s."id" = p."sessionId"
      WHERE p."centerId" = ${centerId} AND p."voided" = false ${dayRangeSql(SESSION_DATE, range)}
      GROUP BY p."teacherId"`,
    db.$queryRaw<(MoneyRow & { teacherId: string })[]>`
      SELECT r."teacherId",
             COALESCE(SUM(r."amount"), 0)::bigint AS "amount",
             COALESCE(SUM(r."centerShareReversed"), 0)::bigint AS "center",
             COALESCE(SUM(r."teacherShareReversed"), 0)::bigint AS "teacher",
             COUNT(*)::int AS "count"
      FROM "Refund" r
      JOIN "Payment" p ON p."id" = r."paymentId"
      JOIN "Session" s ON s."id" = p."sessionId"
      WHERE r."centerId" = ${centerId} ${dayRangeSql(SESSION_DATE, range)}
      GROUP BY r."teacherId"`,
  ]);

  const refundByTeacher = new Map(refundRows.map((row) => [row.teacherId, row]));

  return rows
    .map((row) => {
      const refund = refundByTeacher.get(row.teacherId);
      return {
        teacherId: row.teacherId,
        collected: moneyNumber(row.amount) - moneyNumber(refund?.amount),
        centerShare: moneyNumber(row.center) - moneyNumber(refund?.center),
        teacherShare: moneyNumber(row.teacher) - moneyNumber(refund?.teacher),
        paymentCount: row.count,
      };
    })
    .sort((a, b) => b.collected - a.collected);
}

// ── Expenses ────────────────────────────────────────────────────────────────

export type ExpenseTotals = { total: number; count: number };

/** A voided expense (SEC-2b, D-24) is never counted — it stays as a record only. */
export async function expenseTotals(
  db: Db,
  centerId: string,
  range: DateRange,
): Promise<ExpenseTotals> {
  const rows = await db.$queryRaw<{ total: bigint; count: number }[]>`
    SELECT COALESCE(SUM(e."amount"), 0)::bigint AS "total", COUNT(*)::int AS "count"
    FROM "Expense" e
    WHERE e."centerId" = ${centerId} AND e."voided" = false
      ${dayRangeSql(Prisma.sql`e."date"`, range)}`;
  return { total: moneyNumber(rows[0]?.total), count: rows[0]?.count ?? 0 };
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
    // T5 — a drop-in's ABSENT row is never an absence (lib/attendance-rules.ts).
    where: { centerId, ...EXCLUDE_DROP_IN_NO_SHOWS, ...(date ? { session: { date } } : {}) },
    _count: { attendanceStatus: true },
  });

  const counts = { ...EMPTY_STATUS_COUNTS };
  for (const row of rows) counts[row.attendanceStatus] = row._count.attendanceStatus;
  return counts;
}
