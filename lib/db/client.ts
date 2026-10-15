import { PrismaClient } from "@prisma/client";

// Prisma singleton — Next.js dev hot-reload would otherwise open a new pool
// on every module reload and exhaust Supabase connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Dev-only DB timing (docs/08 §4.6.2). `KAYEDU_DB_STATS=1` on a development
 * server prints one `[kayedu:db] <ms>ms <sql>` line per statement and, once
 * the database has been quiet for a moment (a request's last query), one
 * `[kayedu:db] request: …` summary — logical queries, raw statements (the
 * pgbouncer wrapper's `BEGIN`/`DEALLOCATE ALL`/`COMMIT` included), summed
 * statement time and wall time. Never active in production; `npm run
 * perf:queries` turns it on and reads the lines.
 */
const WRAPPER_STATEMENT = /^\s*(BEGIN|COMMIT|DEALLOCATE)\b/i;
const REQUEST_IDLE_MS = 600;

function createClient(): PrismaClient {
  const development = process.env.NODE_ENV === "development";
  if (development && process.env.KAYEDU_DB_STATS === "1") {
    const client = new PrismaClient({
      log: [{ emit: "event", level: "query" }, "warn", "error"],
    });
    let queries = 0;
    let statements = 0;
    let dbMs = 0;
    let firstAt = 0;
    let lastAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    client.$on("query", (event) => {
      const now = Date.now();
      if (statements === 0) firstAt = now - event.duration;
      lastAt = now;
      statements += 1;
      dbMs += event.duration;
      if (!WRAPPER_STATEMENT.test(event.query)) queries += 1;
      console.log(`[kayedu:db] ${event.duration}ms ${event.query.replace(/\s+/g, " ")}`);
      clearTimeout(timer);
      timer = setTimeout(() => {
        console.log(
          `[kayedu:db] request: ${queries} queries, ${statements} statements, ${dbMs} ms db, ${lastAt - firstAt} ms wall`,
        );
        queries = statements = dbMs = 0;
      }, REQUEST_IDLE_MS);
    });
    // The event-emitting client is the same client at runtime; only its log
    // generic differs, which the rest of the app does not care about.
    return client as unknown as PrismaClient;
  }

  return new PrismaClient({
    log:
      development
        ? // `KAYEDU_QUERY_LOG=1` (dev only) prints every statement — what
          // `npm run perf:queries` counts per page request (SYS, docs/08).
          process.env.KAYEDU_QUERY_LOG === "1"
          ? ["query", "warn", "error"]
          : ["warn", "error"]
        : ["error"],
    // SEC-75 (SEC-2c): in production an error message carries no call-site
    // context — the default format quotes the failed call's arguments (a
    // student's name, a phone) into the message, and from there into the
    // server log. The error code, model and constraint still come through.
    ...(process.env.NODE_ENV === "production" ? { errorFormat: "minimal" as const } : {}),
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
