-- M11: Organization / branch restructure (docs/00-master-product-spec.md §5.1
-- "Branch architecture", docs/01-data-model.md "Organization layer").
--
-- `Organization` becomes the paying customer above `Center`; `Center` stays
-- the tenant and `center_id` remains the sole isolation key. The old
-- location-under-a-tenant `Branch` model is retired — rooms and sessions
-- belong to the centre directly, which is the job `Branch` used to do.
--
-- This is a real production migration, not a fresh seed: every existing
-- `Center` gets exactly one backfilled `Organization`, reusing the Center's
-- own id as the Organization's id so the 1:1 backfill needs no join.

-- ── 1. Organization (global, no centerId) ───────────────────────────────────
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- ── 2. Center.organizationId — added nullable, backfilled, then required ───
ALTER TABLE "Center" ADD COLUMN "organizationId" TEXT;

-- One Organization per existing Center, reusing the Center's id: a real 1:1
-- backfill with no ambiguity (docs/03-build-order.md M11 "Build").
INSERT INTO "Organization" ("id", "name", "nameEn", "active", "createdAt", "updatedAt")
SELECT "id", "name", "nameEn", "active", "createdAt", "updatedAt" FROM "Center";

UPDATE "Center" SET "organizationId" = "id";

ALTER TABLE "Center" ALTER COLUMN "organizationId" SET NOT NULL;

CREATE INDEX "Center_organizationId_idx" ON "Center"("organizationId");

ALTER TABLE "Center" ADD CONSTRAINT "Center_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 3. Retire Branch — Room and Session belong to the centre directly ──────
ALTER TABLE "Room" DROP CONSTRAINT IF EXISTS "Room_branchId_fkey";
ALTER TABLE "Session" DROP CONSTRAINT IF EXISTS "Session_branchId_fkey";
ALTER TABLE "Branch" DROP CONSTRAINT IF EXISTS "Branch_centerId_fkey";

ALTER TABLE "Room" DROP COLUMN "branchId";
ALTER TABLE "Session" DROP COLUMN "branchId";

DROP TABLE "Branch";
