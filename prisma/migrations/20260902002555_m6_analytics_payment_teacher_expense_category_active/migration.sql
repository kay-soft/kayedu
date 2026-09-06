-- AlterTable
ALTER TABLE "ExpenseCategory" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: add nullable first so existing rows (M5 dev/seed data) survive,
-- backfill from the session each payment belongs to, then enforce NOT NULL.
ALTER TABLE "Payment" ADD COLUMN     "teacherId" TEXT;

UPDATE "Payment" p
SET "teacherId" = s."teacherId"
FROM "Session" s
WHERE s.id = p."sessionId";

ALTER TABLE "Payment" ALTER COLUMN "teacherId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Payment_centerId_teacherId_recordedAt_idx" ON "Payment"("centerId", "teacherId", "recordedAt");
