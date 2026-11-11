-- W8a (D-W20, D-W21, D-W28, D-W38): PERSONAL workspaces — the model.
-- Additive only: one enum, three nullable/defaulted Center columns (every
-- existing row becomes BRANCH, never archived) and one nullable, unique
-- Organization column (every existing organization stays a centre's, with no
-- owner). Generated with the read-only `prisma migrate diff --from-url
-- <DIRECT_URL> --to-schema-datamodel prisma/schema.prisma --script`; no DROP
-- INDEX was generated, so the hand-written partial indexes (CLAUDE.md rule 7)
-- are untouched. The two tables already carry the RLS lockdown (SEC-2a).
--
-- Hand-written below the generated part:
--   * two same-row CHECKs on Center's archive columns;
--   * the rule "a PERSONAL centre's organization has an ownerUserId". A CHECK
--     cannot read another table in PostgreSQL, so it is two triggers: one on
--     Center (insert, or a change of kind/organization) and one on
--     Organization (clearing ownerUserId while it holds a PERSONAL centre).
-- The uniqueness of Organization.ownerUserId is Prisma's own `@unique` (the
-- generated `Organization_ownerUserId_key`), so no future diff drops it; NULLs
-- are distinct, so it binds personal organizations only.

-- CreateEnum
CREATE TYPE "CenterKind" AS ENUM ('BRANCH', 'PERSONAL');

-- AlterTable
ALTER TABLE "Center" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedByUserId" TEXT,
ADD COLUMN     "kind" "CenterKind" NOT NULL DEFAULT 'BRANCH';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "ownerUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_ownerUserId_key" ON "Organization"("ownerUserId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Hand-written: the archive columns (D-W28) ──────────────────────────────

-- Both or neither: an archive always says who archived it.
ALTER TABLE "Center" ADD CONSTRAINT "Center_archive_pair_check"
  CHECK (("archivedAt" IS NULL) = ("archivedByUserId" IS NULL));

-- Only a PERSONAL workspace is ever archived by a teacher; a branch's end of
-- life stays the admin's `lifecycleState` / `deletedAt`.
ALTER TABLE "Center" ADD CONSTRAINT "Center_archive_personal_only_check"
  CHECK ("archivedAt" IS NULL OR "kind" = 'PERSONAL');

-- ── Hand-written: a PERSONAL centre's organization has an owner (D-W38) ─────

CREATE FUNCTION public.kayedu_personal_center_owned() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'PERSONAL' AND NOT EXISTS (
    SELECT 1 FROM "Organization" o
    WHERE o."id" = NEW."organizationId" AND o."ownerUserId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A PERSONAL centre must belong to a personal organization (ownerUserId set)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Center_personal_owned"
  BEFORE INSERT OR UPDATE OF "kind", "organizationId" ON "Center"
  FOR EACH ROW EXECUTE FUNCTION public.kayedu_personal_center_owned();

CREATE FUNCTION public.kayedu_personal_org_keeps_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."ownerUserId" IS NULL AND OLD."ownerUserId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Center" c
    WHERE c."organizationId" = NEW."id" AND c."kind" = 'PERSONAL'
  ) THEN
    RAISE EXCEPTION 'A personal organization holding a PERSONAL centre keeps its ownerUserId'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "Organization_personal_keeps_owner"
  BEFORE UPDATE OF "ownerUserId" ON "Organization"
  FOR EACH ROW EXECUTE FUNCTION public.kayedu_personal_org_keeps_owner();

-- The two trigger functions are executable by nobody but their owner (the
-- SEC-2a default privileges already say so; this keeps it explicit, as SEC-2b did).
DO $$
DECLARE
  api_role text;
BEGIN
  REVOKE ALL ON FUNCTION public.kayedu_personal_center_owned() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.kayedu_personal_org_keeps_owner() FROM PUBLIC;
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.kayedu_personal_center_owned() FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.kayedu_personal_org_keeps_owner() FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
