/**
 * The pieces of `npm run check:all` that decide what a summary row says (G2).
 * Pure functions with injected effects — no database, no child process — so the
 * logic can be exercised without touching either.
 *
 * Why they exist: in the first staging run, 13 gates failed in under a second
 * right after `check:student-portal` while later gates connected fine — a
 * short window in which the database refused connections — and the summary
 * said only FAIL. So (1) the runner waits for the database before each
 * database-backed gate and reports "DB UNREACHABLE" if it never answers, and
 * (2) a gate that fails within `FAST_FAIL_MS` has its first error line printed
 * under its summary row.
 */
import { readFileSync } from "node:fs";

/** A gate that fails faster than this died on startup; its first error line goes in the summary. */
export const FAST_FAIL_MS = 5_000;
/** How long the runner waits for the database before a gate, and how long it pauses between attempts. */
export const DB_WAIT_MS = 60_000;
export const DB_WAIT_PAUSE_MS = 2_000;

export type WaitResult =
  | { ok: true; attempts: number; waitedMs: number }
  | { ok: false; attempts: number; waitedMs: number; lastError: string };

type WaitOptions = {
  timeoutMs?: number;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Runs `probe` (a `SELECT 1`) until it succeeds or `timeoutMs` has passed,
 * pausing `pauseMs` between attempts. A probe that throws is "not yet".
 */
export async function waitForDatabase(probe: () => Promise<void>, options: WaitOptions = {}): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? DB_WAIT_MS;
  const pauseMs = options.pauseMs ?? DB_WAIT_PAUSE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  let attempts = 0;
  let lastError = "";
  for (;;) {
    attempts += 1;
    try {
      await probe();
      return { ok: true, attempts, waitedMs: now() - started };
    } catch (error) {
      lastError = redact(firstLine((error as Error)?.message ?? String(error)));
    }
    if (now() - started + pauseMs >= timeoutMs) return { ok: false, attempts, waitedMs: now() - started, lastError };
    await sleep(pauseMs);
  }
}

/** Whether a gate script opens a database client of its own (`gatePrisma(` / `PrismaClient`) — the runner probes the database only before those. */
export function isDatabaseBacked(gateScriptSource: string): boolean {
  return /gatePrisma\(|PrismaClient/.test(gateScriptSource);
}

/** The script file a `package.json` gate script runs (`node scripts/with-env.ts scripts/x-check.ts`). */
export function gateScriptFile(packageScript: string | undefined): string | null {
  return packageScript?.match(/scripts\/[\w.-]+\.ts/g)?.pop() ?? null;
}

export function gateIsDatabaseBacked(name: string, packageJsonPath = "package.json"): boolean {
  const scripts = (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts: Record<string, string> }).scripts;
  const file = gateScriptFile(scripts[name]);
  // A gate this cannot classify is treated as database-backed: waiting for a database it does not use costs a second, skipping the wait costs a diagnosis.
  return file === null ? true : isDatabaseBacked(readFileSync(file, "utf8"));
}

const firstLine = (text: string) => text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";

/** A connection string's credentials never reach a summary line. */
export function redact(line: string): string {
  return line.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+):[^@\s]+@/gi, "$1:***@");
}

const ERROR_LINE = /\b(\w*Error|ERR_\w+|ECONN\w*|P\d{4}|REFUSED|FAILED?|EADDR\w+|ETIMEDOUT)\b|can't reach|too many|refused/i;

/**
 * The first line of a gate's output worth showing under its summary row: the
 * first line of stderr that names an error, else of stdout, else the first
 * non-empty stderr line, else the first non-empty stdout line. Credentials in
 * a connection string are masked; the line is cut at 240 characters.
 */
export function firstErrorLine(stderr: string, stdout: string): string | null {
  const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  const err = lines(stderr);
  const out = lines(stdout);
  const pick = err.find((line) => ERROR_LINE.test(line)) ?? out.find((line) => ERROR_LINE.test(line)) ?? err[0] ?? out[0];
  if (!pick) return null;
  const masked = redact(pick);
  return masked.length > 240 ? `${masked.slice(0, 237)}...` : masked;
}

export type GateResult = {
  name: string;
  code: number;
  ms: number;
  timedOut: boolean;
  /** The database never answered within the wait, so the gate was not started. */
  unreachable?: { waitedMs: number; lastError: string };
  /** Set only when the gate failed in under `FAST_FAIL_MS`. */
  startupError?: string | null;
};

export type GateStatus = "PASS" | "FAIL" | "TIMEOUT" | "DB UNREACHABLE";

export function gateStatus(result: GateResult): GateStatus {
  if (result.unreachable) return "DB UNREACHABLE";
  if (result.code === 0) return "PASS";
  return result.timedOut ? "TIMEOUT" : "FAIL";
}

/** The summary row, and — for a fast failure or an unreachable database — the line under it. */
export function summaryLines(result: GateResult): string[] {
  const status = gateStatus(result);
  const seconds = result.unreachable ? result.unreachable.waitedMs / 1000 : result.ms / 1000;
  const lines = [`  ${status.padEnd(14)} ${result.name.padEnd(28)} ${seconds.toFixed(0)}s`];
  if (result.unreachable) {
    lines.push(`    ↳ not started: SELECT 1 failed for ${(result.unreachable.waitedMs / 1000).toFixed(0)}s — ${result.unreachable.lastError || "no error text"}`);
  } else if (result.code !== 0 && result.startupError) {
    lines.push(`    ↳ failed in ${(result.ms / 1000).toFixed(1)}s: ${result.startupError}`);
  }
  return lines;
}
