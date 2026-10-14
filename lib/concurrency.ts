/**
 * Runs `fn` over `items` with at most `limit` calls in flight, results in
 * input order (SEC-2c, SEC-32). For a page that fans out one query set per
 * centre: an unbounded `Promise.all` over every centre on the platform would
 * hold that many pool connections per page load, for everyone.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
