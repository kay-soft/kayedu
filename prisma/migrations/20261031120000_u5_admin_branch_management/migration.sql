-- AlterTable
ALTER TABLE "Center" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "restorableUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "pauseId" TEXT;

-- CreateTable
CREATE TABLE "BranchPause" (
    "id" TEXT NOT NULL,
    "centerId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedEarlyAt" TIMESTAMP(3),
    "endedEarlyBy" TEXT,

    CONSTRAINT "BranchPause_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BranchPause_centerId_endDate_idx" ON "BranchPause"("centerId", "endDate");

-- CreateIndex
CREATE INDEX "Session_pauseId_idx" ON "Session"("pauseId");

-- AddForeignKey
ALTER TABLE "BranchPause" ADD CONSTRAINT "BranchPause_centerId_fkey" FOREIGN KEY ("centerId") REFERENCES "Center"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_pauseId_fkey" FOREIGN KEY ("pauseId") REFERENCES "BranchPause"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Hand-written (U5) ─────────────────────────────────────────────────────

-- Every table in `public` has RLS on with zero policies (docs/02 §12,
-- `check:rls`); a new table enables it in its own migration.
ALTER TABLE "BranchPause" ENABLE ROW LEVEL SECURITY;

-- A pause is an inclusive day range of at most 90 days, end on or after start
-- (lib/db/branch-admin.ts refuses first; this is the backstop).
ALTER TABLE "BranchPause" ADD CONSTRAINT "BranchPause_range_check"
  CHECK ("endDate" >= "startDate" AND "endDate" <= "startDate" + INTERVAL '89 days');

-- A deleted branch always carries its restore deadline, and only a deleted one.
ALTER TABLE "Center" ADD CONSTRAINT "Center_deleted_restorable_check"
  CHECK (("deletedAt" IS NULL) = ("restorableUntil" IS NULL));
