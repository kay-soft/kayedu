-- F5: whether a branch appears on the public Explore pages (guests).
-- Additive only: one column with a default; every existing branch is listed.
-- Only ACTIVE/GRACE branches are ever shown, whatever this says.
-- (Generated with the read-only `prisma migrate diff --from-url ... --script`.)

-- AlterTable
ALTER TABLE "CenterSettings" ADD COLUMN     "publicListing" BOOLEAN NOT NULL DEFAULT true;
