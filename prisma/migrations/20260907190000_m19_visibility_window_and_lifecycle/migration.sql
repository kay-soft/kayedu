-- M19: data-visibility window + centre lifecycle
-- (docs/00-master-product-spec.md §5.1 "Data visibility window" / "Centre
-- lifecycle").
--
-- CenterLifecycleState replaces Center.active. Backfilled from the boolean
-- before it is dropped, exactly per the confirmed mapping: active=true
-- becomes ACTIVE (unrestricted, the boolean's old "on" state), active=false
-- becomes SUSPENDED (blocks sign-in, the boolean's old "off" state) — the two
-- states ONBOARDING/GRACE/ARCHIVED are new and reached only via an explicit
-- lifecycle transition going forward, never by this backfill.
--
-- Center.plan is removed entirely — free-text onboarding metadata with no
-- behavior behind it (CLAUDE.md "Center cut" / M19 spec).

-- CreateEnum
CREATE TYPE "CenterLifecycleState" AS ENUM ('ONBOARDING', 'ACTIVE', 'GRACE', 'SUSPENDED', 'ARCHIVED');

-- AlterTable: add the new lifecycle column (temporarily nullable so the
-- backfill below can distinguish "not yet set" from a real value, then
-- tightened to NOT NULL once every row has one).
ALTER TABLE "Center" ADD COLUMN "lifecycleState" "CenterLifecycleState";

-- Backfill from the boolean this column replaces.
UPDATE "Center"
SET "lifecycleState" = CASE WHEN "active" THEN 'ACTIVE' ELSE 'SUSPENDED' END::"CenterLifecycleState";

-- Every row now has a value — enforce it and match the schema's default.
ALTER TABLE "Center" ALTER COLUMN "lifecycleState" SET NOT NULL;
ALTER TABLE "Center" ALTER COLUMN "lifecycleState" SET DEFAULT 'ACTIVE';

-- Drop the fields this milestone removes entirely.
ALTER TABLE "Center" DROP COLUMN "active";
ALTER TABLE "Center" DROP COLUMN "plan";

-- AlterTable: the per-centre data-visibility window (docs/01-data-model.md
-- §7), defaulting every existing centre to the settled 1-calendar-month
-- (30-day rolling) default.
ALTER TABLE "CenterSettings" ADD COLUMN "dataVisibilityDays" INTEGER NOT NULL DEFAULT 30;
