import type { Prisma, PrismaClient } from "@prisma/client";

// Relative imports on purpose — `npm run check:branches` exercises this
// module directly, outside the Next.js runtime (same reasoning as
// lib/db/analytics.ts). Every function here is a union of independent,
// centerId-scoped calls into lib/db/analytics.ts, summed in memory — never a
// single query with `centerId: { in: [...] } }` (docs/02-architecture.md §4:
// "the moment a scoped helper accepts a list, 'is this query isolated?'
// stops being answerable by inspection").
import {
  expenseTotals,
  revenueTotals,
  studentCounts,
  teacherCounts,
  type DateRange,
  type ExpenseTotals,
  type RevenueTotals,
  type StudentCounts,
  type TeacherCounts,
} from "./analytics.ts";
import { ACCESSIBLE_LIFECYCLE_STATES } from "./platform.ts";

type Db = PrismaClient | Prisma.TransactionClient;

const EMPTY_REVENUE: RevenueTotals = {
  collected: 0,
  centerShare: 0,
  teacherShare: 0,
  paymentCount: 0,
};

function sumRevenue(rows: RevenueTotals[]): RevenueTotals {
  return rows.reduce(
    (sum, row) => ({
      collected: sum.collected + row.collected,
      centerShare: sum.centerShare + row.centerShare,
      teacherShare: sum.teacherShare + row.teacherShare,
      paymentCount: sum.paymentCount + row.paymentCount,
    }),
    EMPTY_REVENUE,
  );
}

/**
 * One `revenueTotals` call per branch, summed in the application layer — the
 * "Whole Management" roll-up (docs/00-master-product-spec.md §5.1 "Branch
 * architecture"). Equal by construction to the sum of each branch's own
 * figure, which is exactly what `npm run check:branches` asserts.
 */
export async function revenueTotalsRollup(
  db: Db,
  branchIds: string[],
  range: DateRange,
  teacherId?: string | null,
): Promise<RevenueTotals> {
  const rows = await Promise.all(
    branchIds.map((centerId) => revenueTotals(db, centerId, range, teacherId)),
  );
  return sumRevenue(rows);
}

/** Per-branch figures, for a roll-up breakdown table — never fetched as one query. */
export async function revenueByBranch(
  db: Db,
  branches: { id: string; name: string }[],
  range: DateRange,
): Promise<(RevenueTotals & { branchId: string; branchName: string })[]> {
  const rows = await Promise.all(
    branches.map(async (branch) => ({
      branchId: branch.id,
      branchName: branch.name,
      ...(await revenueTotals(db, branch.id, range)),
    })),
  );
  return rows.sort((a, b) => b.collected - a.collected);
}

export async function expenseTotalsRollup(
  db: Db,
  branchIds: string[],
  range: DateRange,
): Promise<ExpenseTotals> {
  const rows = await Promise.all(
    branchIds.map((centerId) => expenseTotals(db, centerId, range)),
  );
  return rows.reduce(
    (sum, row) => ({ total: sum.total + row.total, count: sum.count + row.count }),
    { total: 0, count: 0 },
  );
}

export async function studentCountsRollup(
  db: Db,
  branchIds: string[],
  range: DateRange,
): Promise<StudentCounts> {
  const rows = await Promise.all(
    branchIds.map((centerId) => studentCounts(db, centerId, range)),
  );
  return rows.reduce(
    (sum, row) => ({ total: sum.total + row.total, new: sum.new + row.new }),
    { total: 0, new: 0 },
  );
}

export async function teacherCountsRollup(
  db: Db,
  branchIds: string[],
  range: DateRange,
): Promise<TeacherCounts> {
  const rows = await Promise.all(
    branchIds.map((centerId) => teacherCounts(db, centerId, range)),
  );
  return rows.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      active: sum.active + row.active,
      new: sum.new + row.new,
    }),
    { total: 0, active: 0, new: 0 },
  );
}

/**
 * Every reachable branch under an organization (ONBOARDING/ACTIVE/GRACE,
 * M19) — the set an Owner's "Whole Management" view sums over. A plain
 * `Center.findMany`, not a `scoped()` call: `Organization` isolates nothing
 * (it is the thing *above* the tenant), so there is no `centerId` to scope
 * this lookup by in the first place (docs/01-data-model.md, Organization
 * layer).
 */
export async function organizationBranches(
  db: Db,
  organizationId: string,
): Promise<{ id: string; name: string }[]> {
  return db.center.findMany({
    where: { organizationId, lifecycleState: { in: [...ACCESSIBLE_LIFECYCLE_STATES] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}
