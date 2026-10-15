/**
 * The production fence for the demo seed and the dev wipe (SEC-2a, SEC-70).
 *
 * Their old guard compared two values from the same `.env` (DATABASE_URL's
 * project ref and DEV_PROJECT_REF), so a `.env` edited or copied carelessly
 * could pass it against any project. This adds two refusals that no `.env`
 * can talk its way past:
 *  - a **committed** list of production project refs — fill it in the moment
 *    the production Supabase project exists (an M20 checklist item);
 *  - the production deployment's own environment (`VERCEL_ENV=production` or
 *    `KAYEDU_ENV=production`).
 */
import { projectRefOf } from "./auth.ts";

/** Supabase project refs that are production. Never seeded, never wiped. */
export const PRODUCTION_PROJECT_REFS: readonly string[] = [];

/** Why this environment is production — or null when it is not. */
export function productionTargetReason(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.VERCEL_ENV === "production" || env.KAYEDU_ENV === "production") {
    return "this is the production deployment's environment";
  }
  for (const name of ["DATABASE_URL", "DIRECT_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const) {
    const ref = projectRefOf(env[name]);
    if (ref && PRODUCTION_PROJECT_REFS.includes(ref)) {
      return `${name} points at production project '${ref}'`;
    }
  }
  return null;
}
