/**
 * The one environment loader and the one write-guard for every script, the
 * seed, Prisma commands run through `with-env.ts`, and the e2e suite (S1).
 *
 * **Loading.** `KAYEDU_ENV=staging` reads `.env.staging` and lets it OVERRIDE
 * anything already in the process (Prisma's own `.env` load included); every
 * key `.env` defines that `.env.staging` does not is blanked, so a staging run
 * can never inherit a single dev value — not from Prisma, not from the Next
 * dev server Playwright starts (neither overrides a variable that is already
 * set). A staging run with no `.env.staging` stops: it never falls back to
 * `.env`. Otherwise `.env` is loaded the way `node --env-file-if-exists` did —
 * a variable already in the shell wins, a missing file is fine.
 *
 * **The guard.** `assertSafeToWrite` is what every database-writing `check:*`
 * gate (via `gatePrisma`), `check:all`, `gates:users` and `npm run e2e` call
 * before they connect. It refuses unless `KAYEDU_ENV=staging` or the database
 * is on this machine, and refuses when the target is the same database as the
 * dev project in `.env`. There is no override flag. `db:seed`, `db:wipe-dev`
 * and `seed:verify` are NOT guarded here: they keep their own fences
 * (`DEV_PROJECT_REF`, `ALLOW_DEV_WIPE`) because the dev project is their target.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { projectRefOf } from "../../prisma/seed-data/auth.ts";
import { productionTargetReason } from "../../prisma/seed-data/production-refs.ts";

type Env = Record<string, string | undefined>;

export const DEV_ENV_FILE = ".env";
export const STAGING_ENV_FILE = ".env.staging";

/** What a staging run cannot do without — checked so a half-filled file fails here, not mid-run. */
export const REQUIRED_STAGING_KEYS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_APP_URL",
  "DEV_PROJECT_REF",
  "SEED_PASSWORD",
  "SEED_ADMIN_PASSWORD",
] as const;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

export const isStaging = (env: Env = process.env) => env.KAYEDU_ENV === "staging";

function readEnvFile(path: string): Record<string, string> | null {
  return existsSync(path) ? (parseEnv(readFileSync(path, "utf8")) as Record<string, string>) : null;
}

function parsed(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function isLocalDatabaseUrl(raw: string | undefined): boolean {
  const url = parsed(raw);
  return url !== null && LOCAL_HOSTS.includes(url.hostname);
}

/**
 * Whether two connection strings name the same database. Supabase poolers in
 * one region share a hostname across projects, so the host alone would call
 * every same-region project "dev": the project ref (pooler user
 * `postgres.<ref>`, or the direct host) decides when both have one.
 */
export function sameDatabase(a: string | undefined, b: string | undefined): boolean {
  const urlA = parsed(a);
  const urlB = parsed(b);
  if (!urlA || !urlB) return false;
  const refA = projectRefOf(a);
  const refB = projectRefOf(b);
  if (refA && refB) return refA === refB;
  if (refA || refB) return false;
  const local = LOCAL_HOSTS.includes(urlA.hostname);
  return (
    urlA.hostname === urlB.hostname &&
    decodeURIComponent(urlA.username) === decodeURIComponent(urlB.username) &&
    urlA.pathname === urlB.pathname &&
    (!local || urlA.port === urlB.port)
  );
}

/** Why a database-writing run must not go ahead against `env` — or null when it may. */
export function writeRefusal(env: Env, devEnv: Env | null): string | null {
  const target = env.DATABASE_URL;
  const url = parsed(target);
  if (!url) return "DATABASE_URL is not set (or is not a URL), so there is no database to check.";
  const production = productionTargetReason(env);
  if (production) return `${production}.`;
  const host = url.hostname;
  if (!isStaging(env) && !isLocalDatabaseUrl(target)) {
    return (
      `this run would write to ${host}, which is neither a staging run (KAYEDU_ENV is not 'staging') ` +
      `nor a database on this machine. Gates and e2e write rows; against a shared project that means the dev project.`
    );
  }
  if (devEnv) {
    for (const mine of ["DATABASE_URL", "DIRECT_URL"] as const) {
      for (const theirs of ["DATABASE_URL", "DIRECT_URL"] as const) {
        if (sameDatabase(env[mine], devEnv[theirs])) {
          return `${mine} (${host}) is the same database as ${theirs} in ${DEV_ENV_FILE} — the dev project.`;
        }
      }
    }
  }
  return null;
}

/** The dev project's values, read from the file (not `process.env`, which a staging run has overridden). */
function devEnvFromFile(): Env | null {
  return readEnvFile(DEV_ENV_FILE);
}

/**
 * Stops the process, with a clear message, unless this run may write to its database.
 * `what` names the caller in the message ("check:payments", "npm run e2e").
 */
export function assertSafeToWrite(what: string, env: Env = process.env): void {
  const reason = writeRefusal(env, devEnvFromFile());
  if (!reason) return;
  console.error(
    `\nREFUSED: ${what} writes to its database, and ${reason}\n\n` +
      `  Run it against staging:  $env:KAYEDU_ENV = "staging"   (then the same command; see docs/staging.md)\n` +
      `  or against a throwaway local Postgres (DATABASE_URL on localhost).\n` +
      `  There is no override flag.\n`,
  );
  process.exit(1);
}

function stop(message: string): never {
  console.error(`\nREFUSED: ${message}\n`);
  process.exit(1);
}

/** Loads the environment for this run (see the file header). Idempotent. */
export function loadEnv(env: Env = process.env): void {
  if (!isStaging(env)) {
    const dev = readEnvFile(DEV_ENV_FILE);
    if (dev) for (const [key, value] of Object.entries(dev)) if (env[key] === undefined) env[key] = value;
    return;
  }

  const staging = readEnvFile(STAGING_ENV_FILE);
  if (!staging) {
    // CI keeps its staging values as workflow secrets, not as a file on the runner.
    if (env.GITHUB_ACTIONS === "true") return;
    stop(
      `KAYEDU_ENV=staging but ${STAGING_ENV_FILE} does not exist. It will not fall back to ${DEV_ENV_FILE}. ` +
        `Copy .env.staging.example to ${STAGING_ENV_FILE} and fill it in (docs/staging.md).`,
    );
  }
  const missing = REQUIRED_STAGING_KEYS.filter((key) => !staging[key]?.trim());
  if (missing.length > 0) stop(`${STAGING_ENV_FILE} is missing: ${missing.join(", ")}.`);

  const dev = readEnvFile(DEV_ENV_FILE);
  if (dev) {
    for (const name of ["DATABASE_URL", "DIRECT_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const) {
      const clash = (["DATABASE_URL", "DIRECT_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const).find((devName) =>
        sameProject(staging[name], dev[devName]),
      );
      if (clash) stop(`${STAGING_ENV_FILE} ${name} points at the same project as ${DEV_ENV_FILE} ${clash} — the dev project.`);
    }
    // A key only .env defines is blanked, so no later loader (Prisma, Next) can fill it in from dev.
    for (const key of Object.keys(dev)) if (!(key in staging)) env[key] = "";
  }
  for (const [key, value] of Object.entries(staging)) env[key] = value;
  env.KAYEDU_ENV = "staging";
}

function sameProject(a: string | undefined, b: string | undefined): boolean {
  const refA = projectRefOf(a);
  const refB = projectRefOf(b);
  return refA !== null && refA === refB;
}
