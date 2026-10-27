/**
 * The gate scripts' database client (SEC-2c). Every `check:*` gate builds its
 * client here — `const prisma = await gatePrisma();` — instead of a bare
 * `new PrismaClient()`. Three things come with it:
 *
 * 1. **Timeouts on every gate transaction.** A connection-level
 *    `lock_timeout`/`statement_timeout` is impossible on this stack: Supavisor
 *    (both the transaction pooler and the session pooler) drops a startup
 *    `options=-c …` parameter — probed at SEC-2c, the server reported
 *    `lock_timeout = 0` either way. So the timeouts are set
 *    **transaction-locally** (`set_config(…, true)`) as the first statement
 *    of every `$transaction`, interactive or batch, together with an
 *    `application_name` naming the gate, which `pg_stat_activity` then shows.
 *    A lock wait inside a gate transaction fails after `GATE_LOCK_TIMEOUT`
 *    with Postgres's own "canceling statement due to lock timeout".
 * 2. **A stall watchdog** for everything else (a statement outside a
 *    transaction, where only the server's 2-minute `statement_timeout`
 *    applies). Each query is tracked while it is in flight; one pending
 *    longer than `GATE_STALL_MS` makes the gate print who blocks whom
 *    (`pg_blocking_pids`, the blocker's state, transaction age and last
 *    query) and exit 1 — a fast, explained failure instead of an 11-minute
 *    hang. The next run's pre-clean removes whatever fixtures it left.
 * 3. **User cleanup.** On `$disconnect` it deletes the `User` rows this run
 *    created and left orphaned: created after the client was built (database
 *    clock) or created through this client (by id — a fixture may backdate
 *    `createdAt`), no auth login, not a platform admin, and no relation of any kind
 *    left (the gate's own cleanup has already deleted its centres, which
 *    cascades their memberships and profiles). A person the app creates
 *    always carries a relation or a login, so a concurrent real user is never
 *    swept. This closes the "no email, no phone, never deleted" leak.
 *
 * 4. **The write fence (S1).** Before it connects, `gatePrisma` refuses unless
 *    the run is `KAYEDU_ENV=staging` or on a local database, and never against
 *    the dev project of `.env` (`scripts/lib/env.ts`, `docs/staging.md`).
 *
 * Shared dev database rules still hold (CLAUDE.md rule 7): nothing here
 * resets, truncates or touches a row the run did not create.
 */
import { basename } from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";

import { assertSafeToWrite } from "./env.ts";

/** A gate transaction never waits longer than this for a lock. */
export const GATE_LOCK_TIMEOUT = "15s";
/** …nor runs a single statement longer than this. */
export const GATE_STATEMENT_TIMEOUT = "60s";
/** An in-flight query older than this fails the gate (outside a transaction). */
export const GATE_STALL_MS = 45_000;
const POLL_MS = 5_000;

const gateName = basename(process.argv[1] ?? "gate").replace(/\.[cm]?ts$/, "");

function transactionSettings() {
  return Prisma.sql`SELECT
    set_config('lock_timeout', ${GATE_LOCK_TIMEOUT}, true),
    set_config('statement_timeout', ${GATE_STATEMENT_TIMEOUT}, true),
    set_config('application_name', ${`kayedu-gate:${gateName}`.slice(0, 63)}, true)`;
}

type GateOptions = {
  /** Sweep this run's orphaned users on `$disconnect` (default true). A second client in the same gate (a race's "other desk") passes false. */
  sweepUsers?: boolean;
  log?: Prisma.PrismaClientOptions["log"];
  /** A gate that only reads catalogs (check:rls) may run against any database; every other gate is refused off staging/local (S1). */
  readOnly?: boolean;
};

/**
 * Users this run created — after `since`, or by id when a fixture backdated
 * `createdAt` (check:analytics does) — with no login and no relation left.
 */
export function orphanedUsersSince(since: Date, createdIds: readonly string[] = []): Prisma.UserWhereInput {
  return {
    OR: [{ createdAt: { gte: since } }, ...(createdIds.length > 0 ? [{ id: { in: [...createdIds] } }] : [])],
    authId: null,
    isPlatformAdmin: false,
    memberships: { none: {} },
    studentProfiles: { none: {} },
    taughtClasses: { none: {} },
    taughtSessions: { none: {} },
    settlements: { none: {} },
    reservations: { none: {} },
    parentLinks: { none: {} },
    familyLinksAsParent: { none: {} },
    familyLinksAsStudent: { none: {} },
    familyInvitations: { none: {} },
    sessionRatings: { none: {} },
    sessionRatingSkips: { none: {} },
    accountClaims: { none: {} },
  };
}

/** Who is waiting on a lock right now, and who holds it — printed when a gate stalls. */
export async function describeLockWaits(db: PrismaClient): Promise<string> {
  const rows = await db.$queryRaw<
    {
      pid: number;
      app: string | null;
      waiting: string | null;
      query: string | null;
      blocker: number;
      blockerApp: string | null;
      blockerState: string | null;
      blockerXactAge: string | null;
      blockerQuery: string | null;
    }[]
  >`
    SELECT w.pid, w.application_name AS app, (now() - w.query_start)::text AS waiting,
           left(regexp_replace(w.query, '\\s+', ' ', 'g'), 200) AS query,
           b.pid AS blocker, b.application_name AS "blockerApp", b.state AS "blockerState",
           (now() - b.xact_start)::text AS "blockerXactAge",
           left(regexp_replace(b.query, '\\s+', ' ', 'g'), 200) AS "blockerQuery"
    FROM pg_stat_activity w
    CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid)
    JOIN pg_stat_activity b ON b.pid = bp.pid
    WHERE w.datname = current_database()`;
  if (rows.length === 0) return "  no backend is waiting on a lock (the stall is not a lock wait)";
  return rows
    .map(
      (row) =>
        `  pid ${row.pid} (${row.app ?? "?"}) waiting ${row.waiting} on: ${row.query}\n` +
        `    blocked by pid ${row.blocker} (${row.blockerApp ?? "?"}), state "${row.blockerState}", ` +
        `transaction open ${row.blockerXactAge ?? "-"}, last query: ${row.blockerQuery}`,
    )
    .join("\n");
}

/** Remembers the ids of `User` rows a gate creates through this client. */
function recordCreatedUsers(operation: string, args: unknown, result: unknown, into: Set<string>): void {
  const idOf = (row: unknown) =>
    row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" ? (row as { id: string }).id : null;
  if (operation === "create") {
    const id = idOf(result);
    if (id) into.add(id);
  } else if (operation === "createManyAndReturn" && Array.isArray(result)) {
    for (const row of result) if (idOf(row)) into.add(idOf(row)!);
  } else if (operation === "createMany") {
    const data = (args as { data?: unknown }).data;
    for (const row of Array.isArray(data) ? data : [data]) if (idOf(row)) into.add(idOf(row)!);
  }
}

export async function gatePrisma(options: GateOptions = {}): Promise<PrismaClient> {
  if (!options.readOnly) assertSafeToWrite(`npm run check:${gateName.replace(/-check$/, "")}`);
  const base = new PrismaClient(options.log ? { log: options.log } : undefined);
  const [{ now: startedAt }] = await base.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;

  const inFlight = new Map<number, { label: string; at: number }>();
  const createdUserIds = new Set<string>();
  let sequence = 0;
  const extended = base.$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        const id = ++sequence;
        inFlight.set(id, { label: `${model ?? "raw"}.${operation}`, at: Date.now() });
        try {
          const result = await query(args);
          if (model === "User") recordCreatedUsers(operation, args, result, createdUserIds);
          return result;
        } finally {
          inFlight.delete(id);
        }
      },
    },
  });

  let stalled = false;
  const watchdog = setInterval(() => {
    if (stalled) return;
    const oldest = [...inFlight.values()].sort((a, b) => a.at - b.at)[0];
    if (!oldest || Date.now() - oldest.at < GATE_STALL_MS) return;
    stalled = true;
    const probe = new PrismaClient();
    void describeLockWaits(probe)
      .catch((error: unknown) => `  (could not read pg_stat_activity: ${(error as Error).message})`)
      .then((report) => {
        console.error(
          `\n[gate-db] ${gateName} STALLED: ${oldest.label} pending ${Math.round((Date.now() - oldest.at) / 1000)}s ` +
            `(limit ${GATE_STALL_MS / 1000}s) — failing fast instead of hanging.\n${report}\n`,
        );
      })
      .finally(() => process.exit(1));
  }, POLL_MS);
  watchdog.unref();

  const sweep = async () => {
    if (options.sweepUsers === false) return;
    const where = orphanedUsersSince(startedAt, [...createdUserIds]);
    const orphans = await base.user.findMany({ where, select: { id: true } });
    if (orphans.length === 0) return;
    const { count } = await base.user.deleteMany({
      where: { AND: [{ id: { in: orphans.map((user) => user.id) } }, where] },
    });
    console.log(`[gate-db] removed ${count} user row(s) this run created and left without a relation`);
  };

  const client = new Proxy(extended, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (arg: unknown, transactionOptions?: unknown) => {
          const run = target.$transaction as (...args: unknown[]) => Promise<unknown>;
          if (typeof arg === "function") {
            return run.call(
              target,
              async (tx: Prisma.TransactionClient) => {
                await tx.$executeRaw(transactionSettings());
                return (arg as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx);
              },
              transactionOptions,
            );
          }
          return run
            .call(target, [target.$executeRaw(transactionSettings()), ...(arg as unknown[])], transactionOptions)
            .then((results) => (results as unknown[]).slice(1));
        };
      }
      if (property === "$disconnect") {
        return async () => {
          clearInterval(watchdog);
          try {
            await sweep();
          } finally {
            await base.$disconnect();
          }
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return client as unknown as PrismaClient;
}
