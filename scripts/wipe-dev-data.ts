/**
 * Safe dev wipe (P1) — empties every APPLICATION table in the dev database so
 * the realistic seed can run into a clean slate.
 *
 * Run with:  npm run db:wipe-dev      (THE USER runs this — Claude never does)
 *
 * What it does: one transaction, `TRUNCATE … RESTART IDENTITY CASCADE` over
 * every ordinary table in the `public` schema.
 * What it never touches: `_prisma_migrations` (so `migrate deploy` still sees
 * the history), the `auth` / `storage` / any other Supabase-owned schema
 * (Auth users and uploaded files stay), RLS settings (TRUNCATE changes no
 * policy), extension-owned tables, or any non-table object.
 *
 * Guards — all must hold or nothing runs (CLAUDE.md rule 7: never reset a
 * database casually; this is the one scripted exception and it is fenced):
 *   1. `ALLOW_DEV_WIPE=yes` is set in the environment;
 *   2. the project ref in `DATABASE_URL` (and `DIRECT_URL`, and the Supabase
 *      API URL the seed will use) equals `DEV_PROJECT_REF`;
 *   3. stdin is a terminal and the person types that project ref, exactly,
 *      after being shown the target host and the number of tables.
 * It also refuses if any table outside `public` has a foreign key INTO a table
 * it would truncate (CASCADE would silently reach into a Supabase-owned schema).
 */
import { createInterface } from "node:readline/promises";
import { PrismaClient } from "@prisma/client";
import { foreignKeysIntoPublic, listWipeableTables, truncateAll } from "./lib/wipe.ts";
import { productionTargetReason } from "../prisma/seed-data/production-refs.ts";

const prisma = new PrismaClient();

function fail(message: string): never {
  console.error(`\nREFUSED: ${message}\n`);
  process.exit(1);
}

/** `postgres.<ref>` (pooler user) or `db.<ref>.supabase.co` (direct host) or `<ref>.supabase.co`. */
function projectRefOf(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const user = decodeURIComponent(url.username);
  if (user.startsWith("postgres.")) return user.slice("postgres.".length);
  const host = url.hostname;
  const direct = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (direct) return direct[1];
  const api = host.match(/^([a-z0-9]+)\.supabase\.co$/);
  if (api) return api[1];
  return null;
}

async function main() {
  const devRef = process.env.DEV_PROJECT_REF?.trim();

  // SEC-70: the committed production denylist and the production
  // deployment's own environment refuse before anything else is read.
  const production = productionTargetReason();
  if (production) fail(`Refusing to wipe: ${production}.`);

  if (process.env.ALLOW_DEV_WIPE !== "yes") {
    fail("ALLOW_DEV_WIPE is not set to 'yes'. Set it for this one command, then remove it again.");
  }
  if (!devRef) fail("DEV_PROJECT_REF is not set in .env.");

  const databaseRef = projectRefOf(process.env.DATABASE_URL);
  if (!databaseRef) fail("Could not read a Supabase project ref out of DATABASE_URL.");
  if (databaseRef !== devRef) {
    fail(`DATABASE_URL points at project '${databaseRef}', not DEV_PROJECT_REF '${devRef}'.`);
  }
  for (const name of ["DIRECT_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const) {
    const ref = projectRefOf(process.env[name]);
    if (ref && ref !== devRef) fail(`${name} points at project '${ref}', not DEV_PROJECT_REF '${devRef}'.`);
  }

  const host = new URL(process.env.DATABASE_URL as string).host;

  const names = await listWipeableTables(prisma);
  if (names.length === 0) fail("No application tables found in the public schema.");

  // CASCADE follows foreign keys INTO a truncated table from any schema. If a
  // Supabase-owned table ever referenced one of ours it would be emptied too.
  const foreign = await foreignKeysIntoPublic(prisma);
  if (foreign.length > 0) {
    fail(
      `A table outside 'public' references one of ours (${foreign
        .map((row) => `${row.from_table} → ${row.to_table}`)
        .join(", ")}). Truncating with CASCADE would reach into it.`,
    );
  }

  console.log("\nKayEdu dev wipe");
  console.log(`  Target host     : ${host}`);
  console.log(`  Project ref     : ${databaseRef}`);
  console.log(`  Tables to empty : ${names.length} (public schema, RESTART IDENTITY CASCADE)`);
  console.log("  Kept            : _prisma_migrations, auth.*, storage.*, RLS policies, all Supabase-owned objects");
  console.log("  Not touched     : Supabase Auth users and uploaded files (the seed reuses its own auth accounts)\n");

  if (!process.stdin.isTTY) {
    fail("stdin is not a terminal, so the project ref cannot be typed. Run this from an interactive shell.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`Type the project ref (${devRef.length} characters) to wipe ${names.length} tables: `)).trim();
  rl.close();
  if (typed !== devRef) fail("That is not the project ref. Nothing was changed.");

  await truncateAll(prisma, names);

  const remaining = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT COUNT(*)::bigint AS total FROM "User"`;
  console.log(`\nDone. ${names.length} tables emptied (User rows left: ${remaining[0].total}).`);
  console.log("Next: npm run db:seed, then npm run seed:verify, then remove ALLOW_DEV_WIPE from your environment.\n");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
