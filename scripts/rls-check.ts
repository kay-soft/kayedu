/**
 * The Data API lockdown gate (SEC-2a — SEC-10, SEC-30, SEC-31, SEC-55, SEC-57;
 * decision D-19 (a), docs/02-architecture.md §5 "Layer 2").
 *
 *   npm run check:rls
 *
 * Read-only: it queries the Postgres catalog and nothing else. Run it after
 * `prisma migrate deploy` against every project — dev, the CI project, and
 * production before launch. It passes only when:
 *  - every table in `public` has row-level security on;
 *  - `public` carries zero policies (deny-all: the app never uses the Data API);
 *  - `anon` and `authenticated` hold no USAGE on `public` and no privilege on
 *    any of its tables, sequences or functions, and no default privilege in
 *    `public` would grant them one on a future object;
 *  - every Storage bucket exists and is private, with no `storage.objects`
 *    policy (only the server's service-role client touches Storage).
 * It also prints whether the connecting role bypasses RLS (SEC-57): on
 * Supabase the Prisma role does, so RLS is a backstop for the Data API only —
 * never for the app's own connection.
 */
import { gatePrisma } from "./lib/gate-db.ts";
import { auditRls, rlsProblems } from "./lib/rls-audit.ts";

const prisma = await gatePrisma({ readOnly: true });

async function main(): Promise<number> {
  const result = await auditRls(prisma);
  console.log(`check:rls — ${result.tables} public tables`);
  console.log(`  connecting role: ${result.currentRole} (rolbypassrls=${result.currentRoleBypassesRls})`);
  for (const role of result.roles) {
    console.log(
      `  ${role.role}: schema USAGE=${role.schemaUsage}, tables=${role.tables.length}, sequences=${role.sequences.length}, functions=${role.functions.length}`,
    );
  }
  if (result.roles.length === 0) console.log("  anon/authenticated roles: not present (plain Postgres)");
  console.log(`  public policies: ${result.publicPolicies}`);
  console.log(
    result.buckets
      ? `  buckets: ${result.buckets.map((bucket) => `${bucket.id}${bucket.public ? " (PUBLIC)" : ""}`).join(", ")}; storage.objects policies: ${result.storageObjectPolicies}`
      : "  storage: not present (plain Postgres)",
  );

  const problems = rlsProblems(result);
  for (const problem of problems) console.error(`  FAIL  ${problem}`);
  console.log(problems.length === 0 ? "\nPASS — the Data API is locked down." : `\n${problems.length} problem(s).`);
  return problems.length;
}

main()
  .then((failures) => {
    if (failures > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
