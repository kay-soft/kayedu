-- SEC-2a: deny-all for the Supabase Data API (PostgREST / GraphQL) and Storage
-- (docs/07-security-audit.md SEC-10, SEC-30, SEC-31, SEC-55; decision D-19 (a)).
--
-- The app reaches Postgres only through Prisma (role `postgres`, BYPASSRLS on
-- Supabase) and Storage only through the service-role client on the server.
-- Nothing legitimately uses the public anon key against a table, so the
-- posture is: RLS on for every table in `public`, ZERO policies, and no
-- privilege for `anon` / `authenticated` on the schema, its tables, sequences
-- and functions — including tables created later, through default privileges.
-- Before this migration that lockdown existed only as hand-made state on the
-- dev project; a fresh project (CI, production) exposed every table.
--
-- Written to run on plain Postgres too (CI, a throwaway local cluster): every
-- Supabase-only object (the anon/authenticated roles, the storage schema) is
-- checked for before it is touched. Idempotent.
--
-- A NEW TABLE ADDED BY A LATER MIGRATION MUST ENABLE RLS ITSELF:
--   ALTER TABLE "X" ENABLE ROW LEVEL SECURITY;
-- `npm run check:rls` fails until it does. (Default privileges below already
-- keep anon/authenticated from being granted anything on it.)

DO $$
DECLARE
  r record;
  api_role text;
BEGIN
  -- 1. RLS on every table in `public`, `_prisma_migrations` included.
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
  END LOOP;

  -- 2. No policy of any kind on `public` (deny-all; D-19 (a)).
  FOR r IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
  END LOOP;

  -- 3. Nothing for PUBLIC on the schema's functions, now or later.
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

  -- 4. The two Data API roles get nothing, now or later.
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
      -- Supabase also seeds default privileges owned by supabase_admin. The
      -- migration role may not be allowed to change those: warn, never fail
      -- (check:rls reports any grant that remains).
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
        BEGIN
          EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
          EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
          EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE WARNING 'SEC-2a lockdown: supabase_admin default privileges for % left unchanged', api_role;
        END;
      END IF;
    END IF;
  END LOOP;

  -- 5. Storage: the four buckets exist, are private, and carry their caps
  --    (raster images only for uploads; the ID-card SVG is server-generated).
  --    No storage.objects policy is created: only the server's service-role
  --    client touches Storage, and RLS with zero policies denies everyone else.
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    BEGIN
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES
        ('avatars', 'avatars', false, 1048576, ARRAY['image/png', 'image/jpeg', 'image/webp']),
        ('id-cards', 'id-cards', false, 2097152, ARRAY['image/svg+xml']),
        ('logos', 'logos', false, 524288, ARRAY['image/png', 'image/jpeg', 'image/webp']),
        ('session-uploads', 'session-uploads', false, 20971520, ARRAY['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
      ON CONFLICT (id) DO UPDATE
        SET public = false,
            file_size_limit = EXCLUDED.file_size_limit,
            allowed_mime_types = EXCLUDED.allowed_mime_types;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE WARNING 'SEC-2a lockdown: storage.buckets left unchanged';
    END;
  END IF;
END $$;
