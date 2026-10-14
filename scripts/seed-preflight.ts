/**
 * Seed preflight (P1) — learn about Auth and configuration problems BEFORE the
 * wipe, not after it.
 *
 *   npm run seed:preflight
 *
 * Writes nothing to the application database. Checks:
 *   - SEED_PASSWORD and SEED_ADMIN_PASSWORD are at least 12 characters and
 *     differ (D-21);
 *   - the target is not a production project or environment (SEC-70);
 *   - DEV_PROJECT_REF matches the project ref in DATABASE_URL (and DIRECT_URL,
 *     and the Supabase API URL);
 *   - the service-role key works;
 *   - no seed address already belongs to an auth user the seed did not make
 *     (the seed would refuse it rather than reset someone's password);
 *   - ONE probe auth user — `probe-<random>@<SEED_EMAIL_DOMAIN>`, the seed's own
 *     domain and password — can be created, is found again, and is deleted in a
 *     `finally`. It is the only auth user this ever creates or deletes.
 * Prints PASS, or FAIL with Supabase's exact error text, and lists up to 20 of
 * the other auth users already in the project (emails only).
 */
import { PrismaClient } from "@prisma/client";
import { runAuthPreflight } from "../prisma/seed-data/auth.ts";
import { seedAccounts } from "../prisma/seed-data/plan.ts";

const SHOW_OTHERS = 20;

async function main() {
  const accounts = seedAccounts();
  console.log(`Seed preflight — ${accounts.length} seed accounts`);

  const result = await runAuthPreflight(accounts.map((account) => account.email));
  for (const step of result.steps) {
    console.log(`  ${step.ok ? "PASS" : "FAIL"}  ${step.name} — ${step.detail}`);
  }

  // The application database is reachable (a read-only no-op query).
  if (result.ok) {
    const prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log("  PASS  The application database is reachable");
    } catch (error) {
      result.ok = false;
      console.log(`  FAIL  The application database is reachable — ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await prisma.$disconnect();
    }
  }

  if (result.others.length > 0) {
    console.log(`\nOther auth users already in this project (not seed accounts — never touched): ${result.others.length}`);
    for (const email of result.others.slice(0, SHOW_OTHERS)) console.log(`  ${email}`);
    if (result.others.length > SHOW_OTHERS) console.log(`  … and ${result.others.length - SHOW_OTHERS} more`);
  }

  console.log(result.ok ? "\nPASS — safe to wipe and seed." : "\nFAIL — fix the above before running db:wipe-dev.");
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
