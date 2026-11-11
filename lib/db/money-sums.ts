/**
 * 64-bit money sums (SEC-2b, D-17 (b), SEC-24). Every money column is a
 * Postgres `integer` (piastres), and Prisma's `_sum` on an `integer` column is
 * itself an `integer` — a centre collecting a few million EGP over a long
 * range used to overflow it and fail the page. Every money aggregate is
 * therefore a raw `SUM(...)::bigint`, which Prisma returns as a JS `bigint`;
 * `moneyNumber` turns it into a plain number, which is exact up to 2^53
 * piastres (~90 trillion EGP).
 *
 * No runtime imports, so the gates and money modules use it directly.
 */
export function moneyNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const result = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`Money sum ${String(value)} is beyond exact JavaScript integers.`);
  }
  return result;
}

/**
 * Adds already-exact piastre amounts in memory — the per-source totals the
 * teacher's Earnings page unions (W8d, D-W41; a union of per-centre scoped
 * reads, never one query across centres). Refuses a sum beyond exact integers.
 */
export function sumMoney(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new RangeError(`Money value ${String(value)} is not an exact integer.`);
    total += value;
  }
  if (!Number.isSafeInteger(total)) throw new RangeError(`Money sum ${String(total)} is beyond exact JavaScript integers.`);
  return total;
}
