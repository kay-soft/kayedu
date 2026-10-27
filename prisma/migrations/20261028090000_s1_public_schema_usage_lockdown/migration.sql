-- S1: finish the Data API lockdown on a STOCK Supabase project.
--
-- `20261017090100_sec2a_data_api_lockdown` revoked USAGE on schema `public`
-- from `anon` and `authenticated` by name. On a fresh Supabase project that
-- is a no-op: their USAGE does not come from a grant to them but from the
-- schema's ACL entry for PUBLIC (`=U/pg_database_owner`), which every role
-- inherits. `check:rls` on the new staging project reported exactly that
-- ("authenticated/anon has USAGE on schema public"). The dev project never
-- showed it because its schema ACL had been emptied by hand.
--
-- Revoke from PUBLIC itself. The roles that need the schema keep it through
-- their own entries (`postgres`, and the owner) - the app reaches Postgres
-- only as `postgres` through Prisma, and dev already runs with no PUBLIC
-- entry at all. Idempotent; on plain Postgres (CI cluster, throwaway local
-- database) it only removes PUBLIC's USAGE, which no gate relies on. Written
-- to warn, not fail, if the migration role may not change the schema's ACL.
--
-- NOT fixed here: Supabase's default privileges owned by `supabase_admin`
-- (they list anon/authenticated). `postgres` may not alter another role's
-- defaults, and they only apply to objects `supabase_admin` itself creates in
-- `public`, never to the tables Prisma migrations create. See docs/staging.md §3.
DO $$
BEGIN
  BEGIN
    REVOKE USAGE ON SCHEMA public FROM PUBLIC;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING 'S1 lockdown: USAGE on schema public left granted to PUBLIC';
  END;
END $$;
