import type { Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose: `npm run check:workspaces` and
// `npm run check:assistants` run this module directly, outside Next.js.
import { centreTimeZone, dateKey, todayInTimezone, weekRangeUtc } from "../scheduling.ts";
import { sessionDisplayName } from "../session-label.ts";
import { earningsRange, type EarningsPeriodChoice } from "../validation/earnings.ts";
import {
  paidOutTeacherShare,
  refundTotals,
  revenueTotals,
  teacherMoneyByClass,
  teacherMoneyByDay,
  type TeacherDayMoneyRow,
} from "./analytics.ts";
import { sumMoney } from "./money-sums.ts";
import { teacherHistoryFloor } from "./visibility.ts";
import { ownedWorkspaceWhere } from "./workspaces.ts";

/**
 * The teacher's Earnings (W8d — D-W25, D-W29, D-W41; docs/02-architecture.md
 * §18). **A union of per-source scoped reads, never one query across
 * centres** (CLAUDE.md rule 1, M11): every function below takes one centre id
 * and reads the frozen `Payment` snapshots and `Refund` reversals through the
 * sum helpers in `./analytics.ts` — `revenueTotals` (the dashboard's own
 * total), `refundTotals`, and the grouped `teacherMoneyByClass` /
 * `teacherMoneyByDay`. Nothing is recomputed from a class's current price or
 * cut; amounts are integer piastres end to end (rule 2), and in-memory unions
 * go through `sumMoney`.
 *
 * - **Sources.** A *branch* is one of the teacher's branches where they may
 *   see their own earnings (`analytics.own.view`) — or, for an assistant, where
 *   `assistantCan` grants `analytics.view`. A *workspace* is one the teacher
 *   owns. The caller decides which sources exist; this module never widens a
 *   list it is given.
 * - **Windows (D-W41 item 5).** Each source carries its own floor: the
 *   teacher's `teacherHistoryDays` (U6) for the teacher, at a branch and in a
 *   workspace alike; for an assistant, the stricter of the branch's teacher
 *   window and `teacherHistoryDays` at a branch, `teacherHistoryDays` in a
 *   workspace (D-W19). A period reaching past a floor is clamped
 *   (`clampedFrom`, which the page states). Settlement **records** are never
 *   windowed; the paid-out figure here is the period's own.
 * - **Money kinds (item 3).** A branch shows the gross teacher share, the
 *   refunds, the net collected, and — for the teacher only — the paid-out and
 *   not-yet-paid-out split. A workspace shows collected only: it is never
 *   settled (D-W24), so it has no paid-out figure and never adds to "not yet
 *   paid out". The only figure summed across both kinds is **collected**.
 * - **No student data** (item 7): class and source names only.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type EarningsSourceKind = "BRANCH" | "WORKSPACE";

export type EarningsSource = {
  kind: EarningsSourceKind;
  centerId: string;
  name: string;
  timeZone: string;
  /** The oldest session day this reader may see here, or null (all history). */
  floor: Date | null;
  /** Branch only, and never for an assistant: the paid-out split (D-W41 items 3, 9). */
  withSettlements: boolean;
};

export type EarningsAttendance = { present: number; late: number; absent: number };

export type EarningsClassLine = {
  /** null = the teacher's one-time sessions here (no class). */
  classGroupId: string | null;
  teacherShare: number;
  refunds: number;
  net: number;
  paymentCount: number;
  paidSessions: number;
  attendance: EarningsAttendance;
};

export type SourceEarnings = {
  source: EarningsSource;
  /** The range actually read, after the window — null when the window leaves none of the period. */
  range: { start: Date; end: Date } | null;
  /** The floor that clamped the period, when it did. */
  clampedFrom: Date | null;
  /** Gross teacher share: every non-voided payment, refunded ones included. */
  teacherShare: number;
  /** The teacher share refunds reversed — shown on its own line, never netted silently. */
  refunds: number;
  refundCount: number;
  /** teacherShare − refunds: the money that stayed (= the dashboard's figure). */
  net: number;
  paymentCount: number;
  paidSessions: number;
  attendance: EarningsAttendance;
  /** Branch + teacher only (null otherwise): paid out vs not yet paid out, of `net`. */
  settlement: { paidOut: number; notPaidOut: number } | null;
  classes: EarningsClassLine[];
  days: TeacherDayMoneyRow[];
};

const NO_ATTENDANCE: EarningsAttendance = { present: 0, late: 0, absent: 0 };

/**
 * The period as one source reads it: resolved from the source's own calendar
 * day (R7b), then clamped to its floor — `range` null when the whole period
 * lies before the floor. Pure.
 */
export function sourceRange(
  choice: EarningsPeriodChoice,
  source: Pick<EarningsSource, "timeZone" | "floor">,
  now: Date = new Date(),
): { range: { start: Date; end: Date } | null; clampedFrom: Date | null } {
  const period = earningsRange(choice, todayInTimezone(source.timeZone, now));
  const floor = source.floor;
  if (!floor || period.start.getTime() >= floor.getTime()) return { range: period, clampedFrom: null };
  if (period.end.getTime() < floor.getTime()) return { range: null, clampedFrom: floor };
  return { range: { start: floor, end: period.end }, clampedFrom: floor };
}

/**
 * Present / late / absent per class for this teacher's sessions at one
 * centre in a range — the roster's own rule (`attendanceDisplay`): an ABSENT
 * row counts only on a closed session and never for a drop-in ("Not arrived"
 * otherwise). Counts only — no student is read.
 */
export async function teacherAttendanceByClass(
  db: Db,
  centerId: string,
  teacherId: string,
  range: { start: Date; end: Date },
): Promise<Map<string, EarningsAttendance>> {
  const rows = await db.$queryRaw<{ classGroupId: string | null; status: "PRESENT" | "LATE" | "ABSENT"; count: number }[]>`
    SELECT s."classGroupId", a."attendanceStatus" AS "status", COUNT(*)::int AS "count"
    FROM "SessionAttendee" a
    JOIN "Session" s ON s."id" = a."sessionId"
    WHERE a."centerId" = ${centerId} AND s."centerId" = ${centerId} AND s."teacherId" = ${teacherId}
      AND a."studentProfileId" IS NOT NULL
      AND (a."attendanceStatus" <> 'ABSENT' OR (a."isDropIn" = false AND s."closedAt" IS NOT NULL))
      AND s."date" >= ${dateKey(range.start)}::date AND s."date" <= ${dateKey(range.end)}::date
    GROUP BY s."classGroupId", a."attendanceStatus"`;
  const byClass = new Map<string, EarningsAttendance>();
  for (const row of rows) {
    const key = row.classGroupId ?? "";
    const tally = byClass.get(key) ?? { ...NO_ATTENDANCE };
    if (row.status === "PRESENT") tally.present += row.count;
    else if (row.status === "LATE") tally.late += row.count;
    else tally.absent += row.count;
    byClass.set(key, tally);
  }
  return byClass;
}

function emptySource(source: EarningsSource, clampedFrom: Date | null): SourceEarnings {
  return {
    source,
    range: null,
    clampedFrom,
    teacherShare: 0,
    refunds: 0,
    refundCount: 0,
    net: 0,
    paymentCount: 0,
    paidSessions: 0,
    attendance: { ...NO_ATTENDANCE },
    settlement: source.withSettlements ? { paidOut: 0, notPaidOut: 0 } : null,
    classes: [],
    days: [],
  };
}

/** One source's Earnings over the choice, within its window. */
export async function sourceEarnings(
  db: Db,
  source: EarningsSource,
  teacherId: string,
  choice: EarningsPeriodChoice,
  now: Date = new Date(),
): Promise<SourceEarnings> {
  const { range, clampedFrom } = sourceRange(choice, source, now);
  if (!range) return emptySource(source, clampedFrom);
  const dates = { from: range.start, to: range.end };
  const [totals, refunds, byClass, byDay, attendance, paidOut] = await Promise.all([
    revenueTotals(db, source.centerId, dates, teacherId),
    refundTotals(db, source.centerId, dates, teacherId),
    teacherMoneyByClass(db, source.centerId, teacherId, dates),
    teacherMoneyByDay(db, source.centerId, teacherId, dates),
    teacherAttendanceByClass(db, source.centerId, teacherId, range),
    // A workspace is never settled (D-W24): no claim is ever read for one.
    source.kind === "BRANCH" && source.withSettlements ? paidOutTeacherShare(db, source.centerId, teacherId, dates) : Promise.resolve(0),
  ]);

  const classIds = new Set<string>([...byClass.map((row) => row.classGroupId ?? ""), ...attendance.keys()]);
  const moneyByClass = new Map(byClass.map((row) => [row.classGroupId ?? "", row]));
  const classes = [...classIds].map((key): EarningsClassLine => {
    const money = moneyByClass.get(key);
    return {
      classGroupId: key === "" ? null : key,
      teacherShare: money?.teacherShare ?? 0,
      refunds: money?.refundTeacherShare ?? 0,
      net: (money?.teacherShare ?? 0) - (money?.refundTeacherShare ?? 0),
      paymentCount: money?.paymentCount ?? 0,
      paidSessions: money?.paidSessions ?? 0,
      attendance: attendance.get(key) ?? { ...NO_ATTENDANCE },
    };
  });
  classes.sort((a, b) => b.net - a.net || (a.classGroupId ?? "").localeCompare(b.classGroupId ?? ""));

  // `revenueTotals` is already net of refunds; the gross is that plus what the refunds reversed.
  const net = totals.teacherShare;
  const refunded = totals.paymentCount === 0 ? 0 : refunds.teacherShare;
  return {
    source,
    range,
    clampedFrom,
    teacherShare: net + refunded,
    refunds: refunded,
    refundCount: sumMoney(byClass.map((row) => row.refundCount)),
    net,
    paymentCount: totals.paymentCount,
    paidSessions: sumMoney(classes.map((line) => line.paidSessions)),
    attendance: {
      present: sumMoney(classes.map((line) => line.attendance.present)),
      late: sumMoney(classes.map((line) => line.attendance.late)),
      absent: sumMoney(classes.map((line) => line.attendance.absent)),
    },
    settlement: source.kind === "BRANCH" && source.withSettlements ? { paidOut, notPaidOut: net - paidOut } : null,
    classes,
    days: byDay,
  };
}

export type EarningsTrendRow = { weekStart: string; teacherShare: number; refunds: number };

export type EarningsSummary = {
  /** The one figure summed across branches and workspaces — labelled "collected" (item 3). */
  collected: number;
  branches: { teacherShare: number; refunds: number; net: number; paidOut: number | null; notPaidOut: number | null };
  workspaces: { teacherShare: number; refunds: number; net: number };
  attendance: EarningsAttendance;
  paidSessions: number;
  /** Sunday-start weeks, oldest first — the one small trend (a table, item 2). */
  trend: EarningsTrendRow[];
  /** The latest floor that clamped any source, for the page's note. */
  clampedFrom: Date | null;
};

/** Pure — sums already-scoped per-source results. Never queries. */
export function summarizeEarnings(sources: SourceEarnings[]): EarningsSummary {
  const branches = sources.filter((entry) => entry.source.kind === "BRANCH");
  const workspaces = sources.filter((entry) => entry.source.kind === "WORKSPACE");
  const withSettlements = branches.filter((entry) => entry.settlement !== null);
  const weeks = new Map<string, EarningsTrendRow>();
  for (const entry of sources) {
    for (const day of entry.days) {
      const weekStart = dateKey(weekRangeUtc(new Date(`${day.day}T00:00:00.000Z`)).start);
      const row = weeks.get(weekStart) ?? { weekStart, teacherShare: 0, refunds: 0 };
      row.teacherShare = sumMoney([row.teacherShare, day.teacherShare]);
      row.refunds = sumMoney([row.refunds, day.refundTeacherShare]);
      weeks.set(weekStart, row);
    }
  }
  const clamps = sources.map((entry) => entry.clampedFrom).filter((floor): floor is Date => floor !== null);
  return {
    collected: sumMoney(sources.map((entry) => entry.net)),
    branches: {
      teacherShare: sumMoney(branches.map((entry) => entry.teacherShare)),
      refunds: sumMoney(branches.map((entry) => entry.refunds)),
      net: sumMoney(branches.map((entry) => entry.net)),
      paidOut: withSettlements.length > 0 ? sumMoney(withSettlements.map((entry) => entry.settlement!.paidOut)) : null,
      notPaidOut: withSettlements.length > 0 ? sumMoney(withSettlements.map((entry) => entry.settlement!.notPaidOut)) : null,
    },
    workspaces: {
      teacherShare: sumMoney(workspaces.map((entry) => entry.teacherShare)),
      refunds: sumMoney(workspaces.map((entry) => entry.refunds)),
      net: sumMoney(workspaces.map((entry) => entry.net)),
    },
    attendance: {
      present: sumMoney(sources.map((entry) => entry.attendance.present)),
      late: sumMoney(sources.map((entry) => entry.attendance.late)),
      absent: sumMoney(sources.map((entry) => entry.attendance.absent)),
    },
    paidSessions: sumMoney(sources.map((entry) => entry.paidSessions)),
    trend: [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    clampedFrom: clamps.length > 0 ? new Date(Math.max(...clamps.map((floor) => floor.getTime()))) : null,
  };
}

/** Each source's Earnings, read one source at a time and unioned (never one query across centres). */
export async function teacherEarnings(
  db: Db,
  teacherId: string,
  sources: EarningsSource[],
  choice: EarningsPeriodChoice,
  now: Date = new Date(),
): Promise<{ sources: SourceEarnings[]; summary: EarningsSummary }> {
  const perSource = await Promise.all(sources.map((source) => sourceEarnings(db, source, teacherId, choice, now)));
  return { sources: perSource, summary: summarizeEarnings(perSource) };
}

/**
 * The teacher's own workspaces as Earnings sources (D-W41 item 5): every live
 * workspace they own — archived ones too, since archiving keeps history — with
 * the teacher's `teacherHistoryDays` floor in the workspace's own calendar.
 * Built from the teacher's id alone (`ownedWorkspaceWhere`).
 */
export async function ownedWorkspaceSources(
  db: Db,
  teacherUserId: string,
  teacherHistoryDays: number,
  now: Date = new Date(),
): Promise<EarningsSource[]> {
  const rows = await db.center.findMany({
    where: ownedWorkspaceWhere(teacherUserId),
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, settings: { select: { timezone: true } } },
  });
  return rows.map((row) => {
    const timeZone = centreTimeZone(row.settings);
    return {
      kind: "WORKSPACE" as const,
      centerId: row.id,
      name: row.name,
      timeZone,
      floor: teacherHistoryFloor(teacherHistoryDays, timeZone, now),
      withSettlements: false,
    };
  });
}

/**
 * The classes named by an Earnings breakdown, at one centre — subject and
 * grade with the centre's own display names (`sessionDisplayName` reads them).
 * Scoped by `centerId`; no student is read.
 */
export function earningsClassNames(db: Db, centerId: string, classIds: string[]) {
  const catalog = {
    select: { nameAr: true, nameEn: true, selections: { where: { centerId }, select: { displayNameAr: true, displayNameEn: true }, take: 1 } },
  } as const;
  if (classIds.length === 0) return Promise.resolve([]);
  return db.classGroup.findMany({
    where: { centerId, id: { in: classIds } },
    select: { id: true, subject: catalog, grade: catalog },
  });
}

/**
 * `${centerId}:${classGroupId}` → each breakdown class's name, read one source
 * at a time (its own centre id, its own display names) — the page's labels.
 */
export async function earningsClassLabels(db: Db, results: SourceEarnings[], locale: string): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  await Promise.all(
    results.map(async (entry) => {
      const ids = entry.classes.map((line) => line.classGroupId).filter((id): id is string => id !== null);
      const rows = await earningsClassNames(db, entry.source.centerId, ids);
      for (const row of rows) labels[`${entry.source.centerId}:${row.id}`] = sessionDisplayName(locale, { classGroup: row });
    }),
  );
  return labels;
}

/**
 * The teacher dashboard's "this month, including workspaces" figure's
 * workspace half (D-W41 item 6): each owned workspace's collected teacher
 * share (`revenueTotals`, net of refunds — the dashboard's own function) over
 * that workspace's calendar month, from the teacher's history floor, summed.
 */
export async function workspacesCollectedThisMonth(
  db: Db,
  teacherId: string,
  sources: EarningsSource[],
  now: Date = new Date(),
): Promise<number> {
  const totals = await Promise.all(
    sources
      .filter((source) => source.kind === "WORKSPACE")
      .map(async (source) => {
        const { range } = sourceRange({ period: "month", invalid: false }, source, now);
        if (!range) return 0;
        return (await revenueTotals(db, source.centerId, { from: range.start, to: range.end }, teacherId)).teacherShare;
      }),
  );
  return sumMoney(totals);
}
