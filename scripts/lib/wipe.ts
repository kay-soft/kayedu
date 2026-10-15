/**
 * The mechanics of the dev wipe (P1), separated from its guards so they can be
 * exercised against a throwaway database. **Nothing here decides whether a
 * wipe is allowed** — `scripts/wipe-dev-data.ts` does that (env flag, project
 * ref, typed confirmation) before calling any of it.
 */
import type { PrismaClient } from "@prisma/client";

/**
 * Ordinary / partitioned tables in `public`, minus the migration history and
 * anything an extension owns — the application tables, and only those.
 */
export async function listWipeableTables(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ relname: string }[]>`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname <> '_prisma_migrations'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
      )
    ORDER BY c.relname`;
  const names = rows.map((row) => row.relname);
  for (const name of names) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unexpected table name '${name}'.`);
  }
  return names;
}

/**
 * Foreign keys from a table OUTSIDE `public` into one of ours. `TRUNCATE …
 * CASCADE` follows these, so any hit means the wipe would reach into a
 * Supabase-owned schema — the caller must refuse.
 */
export async function foreignKeysIntoPublic(
  db: PrismaClient,
): Promise<{ from_table: string; to_table: string }[]> {
  return db.$queryRaw<{ from_table: string; to_table: string }[]>`
    SELECT cf.relnamespace::regnamespace::text || '.' || cf.relname AS from_table,
           ct.relname AS to_table
    FROM pg_constraint k
    JOIN pg_class cf ON cf.oid = k.conrelid
    JOIN pg_class ct ON ct.oid = k.confrelid
    JOIN pg_namespace nt ON nt.oid = ct.relnamespace
    WHERE k.contype = 'f' AND nt.nspname = 'public'
      AND cf.relnamespace::regnamespace::text <> 'public'`;
}

/** One transaction: every listed table, `RESTART IDENTITY CASCADE`. */
export async function truncateAll(db: PrismaClient, names: readonly string[]): Promise<void> {
  const list = names.map((name) => `"public"."${name}"`).join(", ");
  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    },
    { timeout: 60_000 },
  );
}
