/**
 * The full gate run's user-leak check (SEC-2c). Each gate deletes the users it
 * creates (`scripts/lib/gate-db.ts` sweeps whatever a gate's own cleanup
 * leaves); this is the run-level proof: the `User` table holds no more rows
 * after the run than before it. `npm run check:all` does both ends itself; CI
 * records the count in its first gate step and verifies it in its last
 * (`npm run gates:users -- record|verify`).
 *
 * The baseline lives in a file outside the repo (the OS temp dir by default,
 * `GATE_USERS_BASELINE` to override), so CI steps — separate processes — can
 * share it. A real person signing up on the shared dev database during a run
 * would also raise the count; the failure message says so.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";

export const BASELINE_FILE = process.env.GATE_USERS_BASELINE ?? join(tmpdir(), "kayedu-gate-users-baseline.json");

type Baseline = { count: number; at: string };

export async function recordUserBaseline(prisma: PrismaClient): Promise<Baseline> {
  const [{ count, at }] = await prisma.$queryRaw<{ count: number; at: Date }[]>`
    SELECT count(*)::int AS count, now() AS at FROM "User"`;
  const baseline = { count, at: at.toISOString() };
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline));
  return baseline;
}

export type UserLeakResult =
  | { ok: true; before: number; after: number }
  | { ok: false; before: number; after: number; leaked: { id: string; createdAt: Date }[] }
  | { ok: false; missingBaseline: true };

export async function verifyUserBaseline(prisma: PrismaClient): Promise<UserLeakResult> {
  if (!existsSync(BASELINE_FILE)) return { ok: false, missingBaseline: true };
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;
  const after = await prisma.user.count();
  if (after <= baseline.count) return { ok: true, before: baseline.count, after };
  const leaked = await prisma.user.findMany({
    where: { createdAt: { gte: new Date(baseline.at) } },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  return { ok: false, before: baseline.count, after, leaked };
}

export function describeUserLeak(result: UserLeakResult): string {
  if (result.ok) return `User rows: ${result.before} before the run, ${result.after} after — no leak.`;
  if ("missingBaseline" in result) return `No baseline at ${BASELINE_FILE} — run "record" before the gates.`;
  return [
    `User rows: ${result.before} before the run, ${result.after} after — ${result.after - result.before} leaked.`,
    "Created during the run and still present (ids only; a real sign-up on the shared dev database would also show here):",
    ...result.leaked.map((user) => `  ${user.id}  ${user.createdAt.toISOString()}`),
  ].join("\n");
}
