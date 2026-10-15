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
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { describeUserLeak, recordUserBaseline, verifyUserBaseline } from "./lib/gate-users.ts";

const TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MIN ?? 20) * 60_000;

function gatesFromCi(): string[] {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const gatesJob = ci.slice(ci.indexOf("\n  gates:"));
  return [...gatesJob.matchAll(/run: npm run (check:[a-z-]+)/g)].map((match) => match[1]);
}

function runGate(name: string): Promise<{ code: number; ms: number; timedOut: boolean }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "--silent", name], { stdio: "inherit", shell: process.platform === "win32" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n[check:all] ${name} exceeded ${TIMEOUT_MS / 60_000} minutes — killing it.`);
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 1 : (code ?? 1), ms: Date.now() - started, timedOut });
    });
  });
}

async function main() {
  const gates = gatesFromCi();
  const prisma = new PrismaClient();
  const baseline = await recordUserBaseline(prisma);
  await prisma.$disconnect();
  console.log(`[check:all] ${gates.length} gates; User rows before the run: ${baseline.count}\n`);

  const results: { name: string; code: number; ms: number; timedOut: boolean }[] = [];
  for (const name of gates) {
    console.log(`\n━━━ ${name} ━━━`);
    results.push({ name, ...(await runGate(name)) });
  }

  const verifier = new PrismaClient();
  const leak = await verifyUserBaseline(verifier);
  await verifier.$disconnect();

  console.log("\n━━━ Summary ━━━");
  for (const result of results) {
    const status = result.code === 0 ? "PASS" : result.timedOut ? "TIMEOUT" : "FAIL";
    console.log(`  ${status.padEnd(7)} ${result.name.padEnd(28)} ${(result.ms / 1000).toFixed(0)}s`);
  }
  console.log(`  ${leak.ok ? "PASS" : "FAIL"}    user rows: ${describeUserLeak(leak)}`);

  const failed = results.filter((result) => result.code !== 0).length + (leak.ok ? 0 : 1);
  console.log(failed === 0 ? "\nEvery gate passed." : `\n${failed} gate(s) FAILED.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
