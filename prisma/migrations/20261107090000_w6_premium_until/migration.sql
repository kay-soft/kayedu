-- W6 (D-W14, D-W35): premium belongs to the person. The exclusive end instant
-- (the Cairo midnight after the last covered day); null = never premium.
-- Additive only: one nullable column. "User" already has its RLS lockdown.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "premiumUntil" TIMESTAMP(3);
