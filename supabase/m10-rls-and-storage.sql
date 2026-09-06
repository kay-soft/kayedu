-- KayEdu — M10 pre-deployment hardening (docs/00-master-product-spec.md §2.1.B)
--
-- NOT auto-applied by `prisma migrate dev`/`deploy` — this lives outside
-- prisma/migrations/ on purpose. RLS policies and storage buckets are
-- security-sensitive and touch a live Supabase project; review this file,
-- then run it once yourself (Supabase Dashboard → SQL Editor, or
-- `psql "$DIRECT_URL" -f supabase/m10-rls-and-storage.sql`) against the
-- intended environment. Idempotent — every statement is safe to re-run.
--
-- What this closes from the checklist:
--   1. "Give the RLS backstop real policies" — policies on every tenant
--      table, mirroring lib/db/tenant-scope.ts's scoping rule exactly:
--      a row is visible only if its center_id is one of the caller's
--      memberships (docs/02-architecture.md §5 layer 2).
--   2. "Remove or lock down public.rls_auto_enable()" — revokes EXECUTE from
--      anon/authenticated if the function exists in this project.
--   3. "Create the remaining Storage buckets" — logos/ and session-uploads/,
--      matching the private/size-limited/centerId-namespaced shape
--      avatars/ and id-cards/ already use (lib/storage-paths.ts, docs §10).
--
-- Prisma connects with the service-role key and BYPASSES RLS by design
-- (docs/02 §5's "Layer 1: application scoping" is the enforced boundary).
-- These policies are the documented backstop for direct PostgREST/Supabase
-- client access — they must never be the only thing standing between a
-- request and another center's data.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Helper functions — no arguments, filter strictly on auth.uid(), the
--    same three names docs/02-architecture.md §10 already documents as
--    backing the Storage policies. CREATE OR REPLACE so this is safe to run
--    whether or not they already exist from earlier manual setup.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.kayedu_member_center_ids()
returns setof text
language sql
security definer
stable
set search_path = public
as $$
  select m."centerId"
  from "Membership" m
  join "User" u on u.id = m."userId"
  where u."authId" = auth.uid()::text
    and m.active = true
$$;

create or replace function public.kayedu_write_center_ids()
returns setof text
language sql
security definer
stable
set search_path = public
as $$
  select m."centerId"
  from "Membership" m
  join "User" u on u.id = m."userId"
  where u."authId" = auth.uid()::text
    and m.active = true
    and m.role in ('OWNER', 'MANAGER', 'RECEPTIONIST')
$$;

create or replace function public.kayedu_own_student_profile_ids()
returns setof text
language sql
security definer
stable
set search_path = public
as $$
  select sp.id
  from "StudentProfile" sp
  join "User" u on u.id = sp."userId"
  where u."authId" = auth.uid()::text
$$;

revoke all on function public.kayedu_member_center_ids() from public, anon;
revoke all on function public.kayedu_write_center_ids() from public, anon;
revoke all on function public.kayedu_own_student_profile_ids() from public, anon;
grant execute on function public.kayedu_member_center_ids() to authenticated;
grant execute on function public.kayedu_write_center_ids() to authenticated;
grant execute on function public.kayedu_own_student_profile_ids() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Lock down public.rls_auto_enable() — a SECURITY DEFINER function the
--    checklist flags as executable by anon/authenticated. Only runs if the
--    function actually exists in this project (it predates this codebase's
--    migration history, created by hand per the checklist note).
-- ─────────────────────────────────────────────────────────────────────────

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. RLS: enable + policy per tenant table. "center_id in caller's
--    memberships" for read; write restricted to OWNER/MANAGER/RECEPTIONIST
--    (kayedu_write_center_ids) for tables staff might touch via a direct
--    client — TEACHER/STUDENT never write through PostgREST in this app
--    (every mutation is a Server Action using the service role), so the
--    write policy is deliberately narrower than the read policy.
-- ─────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
  tenant_tables text[] := array[
    'Branch', 'Membership', 'Invitation', 'EducationSystem', 'Grade',
    'Subject', 'Room', 'ClassGroup', 'ClassSchedule', 'StudentProfile',
    'Enrollment', 'StudentBlock', 'Session', 'SessionAttendee', 'Payment',
    'Holiday', 'ExpenseCategory', 'Expense', 'Reservation', 'ChangeRequest',
    'CenterSettings'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists kayedu_select_own_center on public.%I', t);
    execute format(
      'create policy kayedu_select_own_center on public.%I for select using ("centerId" in (select public.kayedu_member_center_ids()))',
      t
    );
    execute format('drop policy if exists kayedu_write_own_center on public.%I', t);
    execute format(
      'create policy kayedu_write_own_center on public.%I for all using ("centerId" in (select public.kayedu_write_center_ids())) with check ("centerId" in (select public.kayedu_write_center_ids()))',
      t
    );
  end loop;
end $$;

-- Center itself has no centerId column — its own id is the tenant key.
alter table public."Center" enable row level security;
drop policy if exists kayedu_select_own_center on public."Center";
create policy kayedu_select_own_center on public."Center"
  for select using (id in (select public.kayedu_member_center_ids()));

-- AuditLog: read-only for members of the center it belongs to (audit.view,
-- docs/02 §6). No write policy — every AuditLog row is written by the app's
-- service-role connection (writeAuditLog(), CLAUDE.md rule 7), never by a
-- client directly. centerId is nullable (platform-level actions), so a null
-- row is invisible to every center-scoped reader — correct, since a platform
-- action belongs to no tenant to begin with.
alter table public."AuditLog" enable row level security;
drop policy if exists kayedu_select_own_center on public."AuditLog";
create policy kayedu_select_own_center on public."AuditLog"
  for select using ("centerId" in (select public.kayedu_member_center_ids()));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Storage buckets: logos/ and session-uploads/ (docs §10), matching the
--    private, size-limited shape avatars/ and id-cards/ already use.
--    session-uploads/ has no code path writing to it yet (spec §4.2 item 5,
--    "coming soon" placeholder) — provisioned ahead of that feature so the
--    bucket exists when it lands, not because anything reads/writes it today.
-- ─────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos', 'logos', false, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('session-uploads', 'session-uploads', false, 20971520, array['image/png', 'image/jpeg', 'application/pdf'])
on conflict (id) do nothing;

-- Read: any active member of that center folder. Write: OWNER/MANAGER/
-- RECEPTIONIST only for logos/ (branding is a settings action); TEACHER
-- included for session-uploads/ once that feature lands, since it is their
-- own upload — narrowed here to match today's "nobody writes yet" reality,
-- to be revisited when the feature is actually built.

drop policy if exists kayedu_logos_read on storage.objects;
create policy kayedu_logos_read on storage.objects
  for select using (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] in (select public.kayedu_member_center_ids())
  );

drop policy if exists kayedu_logos_write on storage.objects;
create policy kayedu_logos_write on storage.objects
  for all using (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] in (select public.kayedu_write_center_ids())
  ) with check (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] in (select public.kayedu_write_center_ids())
  );

drop policy if exists kayedu_session_uploads_read on storage.objects;
create policy kayedu_session_uploads_read on storage.objects
  for select using (
    bucket_id = 'session-uploads'
    and (storage.foldername(name))[1] in (select public.kayedu_member_center_ids())
  );

drop policy if exists kayedu_session_uploads_write on storage.objects;
create policy kayedu_session_uploads_write on storage.objects
  for all using (
    bucket_id = 'session-uploads'
    and (storage.foldername(name))[1] in (select public.kayedu_write_center_ids())
  ) with check (
    bucket_id = 'session-uploads'
    and (storage.foldername(name))[1] in (select public.kayedu_write_center_ids())
  );
