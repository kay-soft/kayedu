-- F1: a per-organization branch limit, set by a platform admin only.
-- Additive only: one column with a default, a backfill, a CHECK constraint.
-- (Generated with the read-only `prisma migrate diff --from-url ... --script`;
-- the F2 `User.contactPhone` column the same diff reported belongs to F2's own
-- migration, 20261026090000_f2_account_contact_phone, and is not repeated here.)

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "maxBranches" INTEGER NOT NULL DEFAULT 1;

-- Backfill: max(1, the organization's current non-ARCHIVED branch count), so
-- no existing organization starts above its own limit (Center 60's two dev
-- branches backfill to 2; every single-branch organization stays at 1).
UPDATE "Organization" AS o
SET "maxBranches" = GREATEST(1, (
  SELECT COUNT(*)::INTEGER
  FROM "Center" AS c
  WHERE c."organizationId" = o."id"
    AND c."lifecycleState" <> 'ARCHIVED'
));

-- A limit below one would make an organization that can never exist.
ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_maxBranches_min" CHECK ("maxBranches" >= 1);
