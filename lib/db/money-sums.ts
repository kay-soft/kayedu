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
