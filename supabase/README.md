# supabase/

Nothing in this folder is run by hand any more.

The Supabase Data API and Storage posture is **deny-all** (SEC-2a, decision D-19 (a) in `docs/07-security-audit.md` §6) and lives in a checked-in Prisma migration, so every project — dev, CI, production — gets it from `npx prisma migrate deploy`:

- `prisma/migrations/20261017090100_sec2a_data_api_lockdown/migration.sql` — RLS on every table in `public`, zero policies, no privilege for `anon` / `authenticated` on the schema, its tables, sequences and functions (default privileges included), and the four Storage buckets private with their size and type caps.
- `npm run check:rls` — read-only; proves that posture on whichever database `DATABASE_URL` points at. Run it after every `migrate deploy`.

The old `m10-rls-and-storage.sql` (per-tenant policies for PostgREST, never applied) was removed in SEC-2a: it aborted on tables that no longer exist, missed fourteen that do, and its write policies would have let a receptionist rewrite money had they ever been granted (SEC-30, SEC-31). The app reaches Postgres only through Prisma and Storage only through the server's service-role client; nothing uses the anon key against a table.

**A new table added by a later migration must enable RLS itself** (`ALTER TABLE "X" ENABLE ROW LEVEL SECURITY;`) — `check:rls` fails until it does.
