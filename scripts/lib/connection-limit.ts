/**
 * Prisma's `connection_limit` on a connection string — read, and rewritten for
 * a gate's secondary clients (G2). Pure: no database, no environment read, so
 * `check:all`'s header, `gatePrisma` and a unit-level script share one answer.
 */

/** What the server-side pooler (Supavisor, Supabase's default) holds open for the project's `postgres` role. */
export const ASSUMED_POOLER_SIZE = 15;

/**
 * A race's "other desk" (`gatePrisma({ sweepUsers: false })`) never runs more
 * than three operations at once (the widest race is check:security's six
 * enrolments split over two desks), so three connections lose it nothing. A
 * gate that opens the main client (10 in `.env.staging.example`) and two desks
 * could ask the pooler for 10 + 10 + 10 = 30 connections; with this it asks for
 * at most 10 + 3 + 3 = 16 (about 7 in practice: connections open on demand).
 * A precaution against pooler exhaustion, not a diagnosed cause of the G1
 * fast failures — see docs/03-build-order.md G2.
 */
export const GATE_DESK_CONNECTION_LIMIT = 3;

export type ConnectionLimit = { limit: number | null; raw: string | null };

/** The `connection_limit` query parameter of `url`, or `limit: null` when it sets none (Prisma then sizes the pool from the CPU count). */
export function connectionLimitOf(url: string | undefined): ConnectionLimit {
  if (!url) return { limit: null, raw: null };
  let raw: string | null;
  try {
    raw = new URL(url).searchParams.get("connection_limit");
  } catch {
    return { limit: null, raw: null };
  }
  const limit = raw !== null && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  return { limit, raw };
}

/**
 * `url` with `connection_limit` lowered to `limit` — never raised, and `null`
 * when it is already at or under it (nothing to override).
 */
export function lowerConnectionLimit(url: string | undefined, limit: number): string | null {
  if (!url) return null;
  const current = connectionLimitOf(url).limit;
  if (current !== null && current <= limit) return null;
  const lowered = new URL(url);
  lowered.searchParams.set("connection_limit", String(limit));
  return lowered.toString();
}

/** One line for the top of a run: the limit, and where it comes from. */
export function describeConnectionLimit(url: string | undefined): string {
  const { limit } = connectionLimitOf(url);
  return limit !== null ? String(limit) : "not set (Prisma default: physical CPUs × 2 + 1)";
}
