/**
 * A minimal in-process sliding-window rate limiter (M18, spec §5.1
 * "Receptionist phone lookup during registration ... is rate-limited"). No
 * external store: Phase 1 runs a single small Vercel deployment, and this is
 * enough to stop a runaway client loop or a scripted enumeration attempt
 * from hammering the duplicate-match lookup — it is not a distributed
 * rate limiter and does not survive a cold start or span multiple instances.
 * If the pilot ever needs a harder guarantee, move this to a shared store
 * (e.g. the database or Upstash Redis) without changing the call sites.
 */

const hits = new Map<string, number[]>();

/**
 * Returns true when `key` is still under `limit` calls within `windowMs`,
 * and records this call. Returns false (and does *not* record it) once the
 * limit is reached, so a caller can distinguish "refused" from "counted."
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = (hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);

  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }

  recent.push(now);
  hits.set(key, recent);
  return true;
}
