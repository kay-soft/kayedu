-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'ASSESSMENT_PUBLISHED';
ALTER TYPE "NotificationKind" ADD VALUE 'ASSESSMENT_EXTENDED';
ALTER TYPE "NotificationKind" ADD VALUE 'ASSESSMENT_OPENS_SOON';
ALTER TYPE "NotificationKind" ADD VALUE 'ASSESSMENT_DUE_SOON';

-- CreateIndex
CREATE INDEX "Assessment_centerId_status_windowStart_idx" ON "Assessment"("centerId", "status", "windowStart");

-- CreateIndex
CREATE INDEX "Assessment_centerId_status_deadline_idx" ON "Assessment"("centerId", "status", "deadline");

