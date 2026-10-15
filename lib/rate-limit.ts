// Relative import on purpose: `npm run check:security` exercises this module
// outside the Next.js runtime, where the `@/` alias does not resolve.
import { prisma } from "./db/client.ts";
import { logBestEffort } from "./log.ts";

/**
 * The one rate limiter (SEC-2a — SEC-11, SEC-27, SEC-67; spec §5.1). A
 * **fixed-window counter in Postgres** (`RateLimitBucket`), so a limit holds
 * across every serverless instance and survives a cold start — the M18
 * in-process `Map` gave each Vercel instance its own allowance.
 *
 * One atomic upsert per call: the row for `key` either starts a new window at
 * 1 or adds 1 to the current one, and the call is allowed while the count is
 * within `limit`. Refused calls are counted too (a client hammering a closed
 * window gains nothing). Old windows are pruned opportunistically.
 *
 * Fails **closed**: if the store cannot be reached the call is refused, so an
 * outage never turns into an unthrottled lookup.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now();
  const windowStart = new Date(now - (now % windowMs));

  try {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimitBucket" ("key", "windowStart", "count")
      VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitBucket"."windowStart" = EXCLUDED."windowStart"
            THEN "RateLimitBucket"."count" + 1
          ELSE 1
        END,
        "windowStart" = EXCLUDED."windowStart"
      RETURNING "count"
    `;
    if (Math.random() < 0.01) void pruneRateLimitBuckets();
    return (rows[0]?.count ?? Number.POSITIVE_INFINITY) <= limit;
  } catch (error) {
    // Fails closed (refuses), but never silently.
    logBestEffort("rate-limit check")(error);
    return false;
  }
}

/** Drops windows older than a day — no limit in this app spans more. */
export async function pruneRateLimitBuckets(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.rateLimitBucket.deleteMany({
      where: { windowStart: { lt: cutoff } },
    });
    return count;
  } catch (error) {
    logBestEffort("rate-limit prune")(error);
    return 0;
  }
}

/**
 * The limits, named once so a call site never invents its own numbers.
 * `identityLookup*` covers every path that can reveal who owns a contact
 * (D-08): the phone lookup and every add-person submit, per staff member and
 * per centre. Sign-in/registration are keyed per email and per client IP; the
 * self-service writes (D-18) per account and per client IP.
 */
export const RATE_LIMITS = {
  identityLookupPerUser: { limit: 20, windowMs: 60_000 },
  identityLookupPerCenter: { limit: 60, windowMs: 60_000 },
  signInPerEmail: { limit: 10, windowMs: 10 * 60_000 },
  signInPerIp: { limit: 50, windowMs: 10 * 60_000 },
  signUpPerEmail: { limit: 5, windowMs: 60 * 60_000 },
  signUpPerIp: { limit: 10, windowMs: 60 * 60_000 },
  resendPerEmail: { limit: 3, windowMs: 10 * 60_000 },
  resendPerIp: { limit: 10, windowMs: 10 * 60_000 },
  // D-18 (SEC-2c): the student portal's reserve/enrol and the teacher
  // directory's "request to teach here" — per account and per client IP. The
  // IP limits are generous on purpose: a whole centre's Wi-Fi, or a mobile
  // carrier's shared address, is one IP.
  selfServicePerUser: { limit: 30, windowMs: 60 * 60_000 },
  selfServicePerIp: { limit: 300, windowMs: 60 * 60_000 },
  teachRequestPerUser: { limit: 10, windowMs: 24 * 60 * 60_000 },
  teachRequestPerIp: { limit: 30, windowMs: 24 * 60 * 60_000 },
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** Every key must pass; checked in order, so a refused key stops the rest. */
export async function checkRateLimits(
  checks: { name: RateLimitName; key: string }[],
): Promise<boolean> {
  for (const { name, key } of checks) {
    const { limit, windowMs } = RATE_LIMITS[name];
    if (!(await checkRateLimit(`${name}:${key}`, limit, windowMs))) return false;
  }
  return true;
}
