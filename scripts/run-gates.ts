/**
 * `npm run check:all` (SEC-2c) — the full gate run, locally, in CI's order.
 *
 * The gate list is read from `.github/workflows/ci.yml` (every
 * `npm run check:*` step of the database job), so there is one list, not two.
 * Around it: the `User` row count is recorded before and verified after — the
 * run must not leave more users than it found — and each gate gets a
 * wall-clock limit (`GATE_TIMEOUT_MIN`, default 20) as the last resort behind
 * the per-gate stall watchdog in `scripts/lib/gate-db.ts`.
 *
 * Gates run one at a time: several write to the same shared dev database and
 * their concurrency assertions assume nobody else is racing them.
 *
 * G2: before each database-backed gate the runner waits for the database
 * (`SELECT 1`, retried for up to `DB_WAIT_MS`); if it never answers the gate is
 * reported "DB UNREACHABLE", not FAIL. A gate that fails within `FAST_FAIL_MS`
 * has its first error line printed under its summary row. The decisions live in
 * `scripts/lib/gate-runner.ts`.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import {
  ASSUMED_POOLER_SIZE,
  GATE_DESK_CONNECTION_LIMIT,
  connectionLimitOf,
  describeConnectionLimit,
  lowerConnectionLimit,
} from "./lib/connection-limit.ts";
import { assertSafeToWrite } from "./lib/env.ts";
import {
  FAST_FAIL_MS,
  firstErrorLine,
  gateIsDatabaseBacked,
  gateStatus,
  summaryLines,
  waitForDatabase,
  type GateResult,
} from "./lib/gate-runner.ts";
import { describeUserLeak, recordUserBaseline, verifyUserBaseline } from "./lib/gate-users.ts";

const TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MIN ?? 20) * 60_000;
/** A gate's output is kept (for the fast-failure line) up to this many characters per stream. */
const CAPTURE_CHARS = 64_000;
/** One attempt of the readiness probe gives up after this long. */
const PROBE_ATTEMPT_MS = 10_000;

function gatesFromCi(): string[] {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const gatesJob = ci.slice(ci.indexOf("\n  gates:"));
  return [...gatesJob.matchAll(/run: npm run (check:[a-z-]+)/g)].map((match) => match[1]);
}

/** `SELECT 1` on a fresh one-connection client — the same fresh connection a gate opens first. */
async function selectOne(): Promise<void> {
  const url = lowerConnectionLimit(process.env.DATABASE_URL, 1);
  const client = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${PROBE_ATTEMPT_MS / 1000}s`)), PROBE_ATTEMPT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.$disconnect().catch(() => undefined);
  }
}

function runGate(name: string): Promise<Pick<GateResult, "code" | "ms" | "timedOut" | "startupError">> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Output is tee'd (shown live and kept) so a fast failure can be explained in the summary.
    const child = spawn("npm", ["run", "--silent", name], { stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      if (stdout.length < CAPTURE_CHARS) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      if (stderr.length < CAPTURE_CHARS) stderr += chunk.toString("utf8");
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n[check:all] ${name} exceeded ${TIMEOUT_MS / 60_000} minutes — killing it.`);
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const exit = timedOut ? 1 : (code ?? 1);
      resolve({ code: exit, ms, timedOut, startupError: exit !== 0 && ms < FAST_FAIL_MS ? firstErrorLine(stderr, stdout) : undefined });
    });
  });
}

function printConnectionBudget() {
  const url = process.env.DATABASE_URL;
  const main = connectionLimitOf(url).limit;
  const desk = main === null ? GATE_DESK_CONNECTION_LIMIT : Math.min(main, GATE_DESK_CONNECTION_LIMIT);
  console.log("[check:all] connection_limit (Prisma pool size per client):");
  console.log(`  a gate's main client .......... ${describeConnectionLimit(url)}  (DATABASE_URL, unchanged)`);
  console.log(`  a race's other-desk client .... ${desk}  (lowered: a desk never runs more than ${GATE_DESK_CONNECTION_LIMIT} operations at once)`);
  console.log(`  the runner's readiness probe .. 1  (SELECT 1 on a fresh client before each database-backed gate)`);
  console.log(
    `  a gate with two desks asks the pooler for at most ${main ?? "?"} + ${desk} + ${desk}; Supabase's default pooler pool is ${ASSUMED_POOLER_SIZE}.\n`,
  );
}

async function main() {
  assertSafeToWrite("npm run check:all");
  const gates = gatesFromCi();
  printConnectionBudget();
  const prisma = new PrismaClient();
  const baseline = await recordUserBaseline(prisma);
  await prisma.$disconnect();
  console.log(`[check:all] ${gates.length} gates; User rows before the run: ${baseline.count}\n`);

  const results: GateResult[] = [];
  for (const name of gates) {
    console.log(`\n━━━ ${name} ━━━`);
    if (gateIsDatabaseBacked(name)) {
      const ready = await waitForDatabase(selectOne);
      if (!ready.ok) {
        console.error(`[check:all] ${name} not started: the database did not answer SELECT 1 for ${(ready.waitedMs / 1000).toFixed(0)}s (${ready.attempts} attempts) — ${ready.lastError}`);
        results.push({ name, code: 1, ms: 0, timedOut: false, unreachable: { waitedMs: ready.waitedMs, lastError: ready.lastError } });
        continue;
      }
      if (ready.attempts > 1) console.log(`[check:all] the database answered after ${ready.attempts} attempts (${(ready.waitedMs / 1000).toFixed(0)}s)`);
    }
    results.push({ name, ...(await runGate(name)) });
  }

  const verifier = new PrismaClient();
  const leak = await verifyUserBaseline(verifier);
  await verifier.$disconnect();

  console.log("\n━━━ Summary ━━━");
  for (const result of results) for (const line of summaryLines(result)) console.log(line);
  console.log(`  ${(leak.ok ? "PASS" : "FAIL").padEnd(14)} user rows: ${describeUserLeak(leak)}`);

  const unreachable = results.filter((result) => gateStatus(result) === "DB UNREACHABLE").length;
  const failed = results.filter((result) => result.code !== 0 && !result.unreachable).length + (leak.ok ? 0 : 1);
  console.log(
    failed === 0 && unreachable === 0
      ? "\nEvery gate passed."
      : `\n${failed} gate(s) FAILED${unreachable > 0 ? `, ${unreachable} not run: DB UNREACHABLE (not a gate failure — the database did not answer)` : ""}.`,
  );
  if (failed > 0 || unreachable > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
